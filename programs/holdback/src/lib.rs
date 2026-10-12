//! Holdback: auth-capture escrow for Solana with pricing-model presets.
//!
//! A buyer authorizes a payment into a per-payment vault. The money stays in
//! escrow until the policy says where it goes:
//!   - buyer reclaims inside the window (satisfaction guarantee)
//!   - buyer disputes and a named judge rules, possibly a partial refund (pay if useful)
//!   - nobody objects and the window passes: anyone can release (permissionless crank)
//!   - merchant voluntarily refunds at any time before settlement
//!   - a judge who never rules: the buyer is refunded after the dispute timeout
//! On release the amount is split among up to MAX_SPLITS recipients (affiliate,
//! pay-it-forward pool, ...) and the merchant gets the remainder.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("63hjwfJZ8vHLL97WgGezNhuJenF6orxETi2yQGbMbygU");

pub const MAX_SPLITS: usize = 3;
pub const BPS_DENOMINATOR: u16 = 10_000;
pub const PAYMENT_SEED: &[u8] = b"payment";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LISTING_SEED: &[u8] = b"listing";
pub const ITEM_SEED: &[u8] = b"item";

#[program]
pub mod holdback {
    use super::*;

    /// Buyer moves `amount` into escrow under `policy`.
    pub fn authorize(
        ctx: Context<Authorize>,
        payment_id: u64,
        amount: u64,
        policy: Policy,
    ) -> Result<()> {
        require!(amount > 0, HoldbackError::ZeroAmount);
        require!(policy.window_secs > 0, HoldbackError::InvalidWindow);
        require!(policy.splits.len() <= MAX_SPLITS, HoldbackError::TooManySplits);
        let split_total: u32 = policy.splits.iter().map(|s| s.bps as u32).sum();
        require!(
            split_total <= BPS_DENOMINATOR as u32,
            HoldbackError::SplitsExceedTotal
        );
        if policy.judge != Pubkey::default() {
            require!(policy.dispute_timeout_secs > 0, HoldbackError::InvalidWindow);
        }

        let now = now()?;
        let payment = &mut ctx.accounts.payment;
        payment.buyer = ctx.accounts.buyer.key();
        payment.merchant = ctx.accounts.merchant.key();
        payment.mint = ctx.accounts.mint.key();
        payment.payment_id = payment_id;
        payment.amount = amount;
        payment.created_at = now;
        payment.release_at = now
            .checked_add(policy.window_secs)
            .ok_or(HoldbackError::InvalidWindow)?;
        payment.disputed_at = 0;
        payment.dispute_reason = [0; 32];
        payment.refunded = 0;
        payment.status = Status::Held;
        payment.policy = policy;
        payment.bump = ctx.bumps.payment;
        payment.vault_bump = ctx.bumps.vault;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(Authorized {
            payment: payment.key(),
            buyer: payment.buyer,
            merchant: payment.merchant,
            amount,
            release_at: payment.release_at,
            preset: payment.policy.preset,
        });
        Ok(())
    }

    /// Buyer takes the money back inside the window (guarantee presets only).
    pub fn reclaim<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let p = &ctx.accounts.payment;
        require_keys_eq!(ctx.accounts.actor.key(), p.buyer, HoldbackError::Unauthorized);
        require!(p.status == Status::Held, HoldbackError::NotHeld);
        let now = now()?;
        if now < p.release_at {
            require!(p.policy.buyer_can_reclaim, HoldbackError::ReclaimNotAllowed);
        } else {
            require!(p.policy.refund_if_uncaptured, HoldbackError::WindowClosed);
        }
        let amount = p.amount;
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, amount, Status::Refunded)
    }

    /// Buyer objects inside the window; the named judge must now rule.
    pub fn dispute(ctx: Context<Dispute>, reason: [u8; 32]) -> Result<()> {
        let p = &mut ctx.accounts.payment;
        require!(p.status == Status::Held, HoldbackError::NotHeld);
        require!(p.policy.judge != Pubkey::default(), HoldbackError::NoJudge);
        let now = now()?;
        require!(now < p.release_at, HoldbackError::WindowClosed);
        p.status = Status::Disputed;
        p.disputed_at = now;
        p.dispute_reason = reason;
        emit!(Disputed { payment: p.key(), reason });
        Ok(())
    }

    /// The named judge rules on a dispute. `refund_bps` of the amount goes back
    /// to the buyer; the rest is released through the normal split.
    pub fn resolve<'info>(
        ctx: Context<'_, '_, 'info, 'info, Settle<'info>>,
        refund_bps: u16,
    ) -> Result<()> {
        let p = &ctx.accounts.payment;
        require_keys_eq!(ctx.accounts.actor.key(), p.policy.judge, HoldbackError::Unauthorized);
        require!(p.status == Status::Disputed, HoldbackError::NotDisputed);
        require!(refund_bps <= BPS_DENOMINATOR, HoldbackError::SplitsExceedTotal);
        let refund = bps_of(p.amount, refund_bps);
        let status = if refund == p.amount { Status::Refunded } else { Status::Released };
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, refund, status)
    }

    /// Window passed with no objection: anyone can release to merchant + splits.
    pub fn release<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let p = &ctx.accounts.payment;
        require!(p.status == Status::Held, HoldbackError::NotHeld);
        require!(!p.policy.refund_if_uncaptured, HoldbackError::CaptureRequired);
        require!(now()? >= p.release_at, HoldbackError::WindowOpen);
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, 0, Status::Released)
    }

    /// Merchant voluntarily refunds in full before settlement (void).
    pub fn refund<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let p = &ctx.accounts.payment;
        require_keys_eq!(ctx.accounts.actor.key(), p.merchant, HoldbackError::Unauthorized);
        require!(
            p.status == Status::Held || p.status == Status::Disputed,
            HoldbackError::AlreadySettled
        );
        let amount = p.amount;
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, amount, Status::Refunded)
    }

    /// The judge never ruled: after the dispute timeout anyone can refund the buyer.
    pub fn expire_dispute<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let p = &ctx.accounts.payment;
        require!(p.status == Status::Disputed, HoldbackError::NotDisputed);
        let deadline = p
            .disputed_at
            .checked_add(p.policy.dispute_timeout_secs)
            .ok_or(HoldbackError::InvalidWindow)?;
        require!(now()? >= deadline, HoldbackError::WindowOpen);
        let amount = p.amount;
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, amount, Status::Refunded)
    }

    /// Merchant takes `amount` (≤ held) before the window ends; the rest goes back
    /// to the buyer. One primitive behind accepted offers, auction winners paying
    /// the second price, and discounts.
    pub fn capture<'info>(
        ctx: Context<'_, '_, 'info, 'info, Settle<'info>>,
        amount: u64,
    ) -> Result<()> {
        check_capture(&ctx.accounts.payment, ctx.accounts.actor.key(), amount)?;
        // A bid on a listing can only be captured together with delivering the item.
        require_keys_eq!(ctx.accounts.payment.policy.listing, Pubkey::default(), HoldbackError::WrongListing);
        let refund = ctx.accounts.payment.amount - amount;
        let remaining = ctx.remaining_accounts;
        settle(ctx.accounts, remaining, refund, Status::Released)
    }

    /// Seller escrows an item (an NFT: a mint with supply 1) for sale.
    pub fn list_item(ctx: Context<ListItem>, listing_id: u64, reserve: u64) -> Result<()> {
        let l = &mut ctx.accounts.listing;
        l.seller = ctx.accounts.seller.key();
        l.item_mint = ctx.accounts.item_mint.key();
        l.listing_id = listing_id;
        l.reserve = reserve;
        l.status = ListingStatus::Open;
        l.buyer = Pubkey::default();
        l.price = 0;
        l.bump = ctx.bumps.listing;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.seller_item_token.to_account_info(),
                    mint: ctx.accounts.item_mint.to_account_info(),
                    to: ctx.accounts.item_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            1,
            ctx.accounts.item_mint.decimals,
        )?;
        emit!(Listed { listing: l.key(), item_mint: l.item_mint, reserve });
        Ok(())
    }

    /// Delivery versus payment: capture `amount` from the winning hold and hand
    /// the escrowed item to that buyer in the same transaction.
    pub fn capture_sale<'info>(
        ctx: Context<'_, '_, 'info, 'info, CaptureSale<'info>>,
        amount: u64,
    ) -> Result<()> {
        let listing_key = ctx.accounts.listing.key();
        {
            let p = &ctx.accounts.settle.payment;
            check_capture(p, ctx.accounts.settle.actor.key(), amount)?;
            require_keys_eq!(p.policy.listing, listing_key, HoldbackError::WrongListing);
            require_keys_eq!(p.merchant, ctx.accounts.listing.seller, HoldbackError::WrongListing);
            require_keys_eq!(ctx.accounts.buyer_item_token.owner, p.buyer, HoldbackError::WrongTokenOwner);
        }
        let l = &ctx.accounts.listing;
        require!(l.status == ListingStatus::Open, HoldbackError::ListingClosed);
        require!(amount >= l.reserve, HoldbackError::BelowReserve);

        let seller = l.seller;
        let id_bytes = l.listing_id.to_le_bytes();
        let bump = [l.bump];
        let seeds: &[&[u8]] = &[LISTING_SEED, seller.as_ref(), &id_bytes, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.settle.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.item_vault.to_account_info(),
                    mint: ctx.accounts.item_mint.to_account_info(),
                    to: ctx.accounts.buyer_item_token.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                &[seeds],
            ),
            1,
            ctx.accounts.item_mint.decimals,
        )?;

        let buyer = ctx.accounts.settle.payment.buyer;
        let refund = ctx.accounts.settle.payment.amount - amount;
        let remaining = ctx.remaining_accounts;
        settle(&mut ctx.accounts.settle, remaining, refund, Status::Released)?;

        let l = &mut ctx.accounts.listing;
        l.status = ListingStatus::Sold;
        l.buyer = buyer;
        l.price = amount;
        emit!(Sold { listing: listing_key, buyer, price: amount });
        Ok(())
    }

    /// Seller takes an unsold item back out of escrow.
    pub fn delist(ctx: Context<Delist>) -> Result<()> {
        let l = &ctx.accounts.listing;
        require!(l.status == ListingStatus::Open, HoldbackError::ListingClosed);
        let seller = l.seller;
        let id_bytes = l.listing_id.to_le_bytes();
        let bump = [l.bump];
        let seeds: &[&[u8]] = &[LISTING_SEED, seller.as_ref(), &id_bytes, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.item_vault.to_account_info(),
                    mint: ctx.accounts.item_mint.to_account_info(),
                    to: ctx.accounts.seller_item_token.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                &[seeds],
            ),
            1,
            ctx.accounts.item_mint.decimals,
        )?;
        ctx.accounts.listing.status = ListingStatus::Delisted;
        Ok(())
    }
}

fn check_capture(p: &Payment, actor: Pubkey, amount: u64) -> Result<()> {
    require_keys_eq!(actor, p.merchant, HoldbackError::Unauthorized);
    require!(p.status == Status::Held, HoldbackError::NotHeld);
    require!(amount > 0 && amount <= p.amount, HoldbackError::CaptureTooLarge);
    require!(now()? < p.release_at, HoldbackError::WindowClosed);
    Ok(())
}

fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

fn bps_of(amount: u64, bps: u16) -> u64 {
    ((amount as u128 * bps as u128) / BPS_DENOMINATOR as u128) as u64
}

/// Pays `refund` back to the buyer, splits the remainder among the policy's
/// recipients (token accounts passed as remaining accounts, in policy order)
/// with the merchant taking what is left, then closes the vault.
fn settle<'info>(
    a: &mut Settle<'info>,
    remaining_accounts: &'info [AccountInfo<'info>],
    refund: u64,
    status: Status,
) -> Result<()> {
    let payment = &a.payment;
    let released = payment.amount - refund;

    let buyer_key = payment.buyer;
    let id_bytes = payment.payment_id.to_le_bytes();
    let bump = [payment.bump];
    let seeds: &[&[u8]] = &[PAYMENT_SEED, buyer_key.as_ref(), &id_bytes, &bump];
    let signer = &[seeds];

    let pay = |to: AccountInfo<'info>, amount: u64| -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to,
                    authority: payment.to_account_info(),
                },
                signer,
            ),
            amount,
            a.mint.decimals,
        )
    };

    pay(a.buyer_token.to_account_info(), refund)?;

    let mut to_splits = 0u64;
    if released > 0 {
        require!(
            remaining_accounts.len() == payment.policy.splits.len(),
            HoldbackError::SplitAccountsMismatch
        );
        for (split, info) in payment.policy.splits.iter().zip(remaining_accounts.iter()) {
            let ta = InterfaceAccount::<TokenAccount>::try_from(info)?;
            require_keys_eq!(ta.owner, split.recipient, HoldbackError::SplitAccountsMismatch);
            require_keys_eq!(ta.mint, payment.mint, HoldbackError::SplitAccountsMismatch);
            let share = bps_of(released, split.bps);
            pay(info.clone(), share)?;
            to_splits += share;
        }
    }
    let to_merchant = released - to_splits;
    pay(a.merchant_token.to_account_info(), to_merchant)?;

    token_interface::close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.buyer.to_account_info(),
            authority: payment.to_account_info(),
        },
        signer,
    ))?;

    let payment = &mut a.payment;
    payment.status = status;
    payment.refunded = refund;
    emit!(Settled {
        payment: payment.key(),
        status,
        refunded: refund,
        to_merchant,
        to_splits,
    });
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct Authorize<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: only recorded as the payee; it never signs here.
    pub merchant: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
        token::token_program = token_program,
    )]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Payment::INIT_SPACE,
        seeds = [PAYMENT_SEED, buyer.key().as_ref(), &payment_id.to_le_bytes()],
        bump,
    )]
    pub payment: Account<'info, Payment>,
    #[account(
        init,
        payer = buyer,
        seeds = [VAULT_SEED, payment.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = payment,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(address = payment.buyer @ HoldbackError::Unauthorized)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.buyer.as_ref(), &payment.payment_id.to_le_bytes()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,
}

/// Shared by every instruction that moves money out of escrow. Who may sign
/// (`actor`) is checked inside each instruction.
#[derive(Accounts)]
pub struct Settle<'info> {
    pub actor: Signer<'info>,
    #[account(
        mut,
        seeds = [PAYMENT_SEED, payment.buyer.as_ref(), &payment.payment_id.to_le_bytes()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,
    #[account(
        mut,
        seeds = [VAULT_SEED, payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = payment.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        constraint = buyer_token.owner == payment.buyer @ HoldbackError::WrongTokenOwner,
    )]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        constraint = merchant_token.owner == payment.merchant @ HoldbackError::WrongTokenOwner,
    )]
    pub merchant_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: receives the vault's rent when it closes; must be the buyer who paid it.
    #[account(mut, address = payment.buyer)]
    pub buyer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(listing_id: u64)]
pub struct ListItem<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub item_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = item_mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_item_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, seller.key().as_ref(), &listing_id.to_le_bytes()],
        bump,
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        init,
        payer = seller,
        seeds = [ITEM_SEED, listing.key().as_ref()],
        bump,
        token::mint = item_mint,
        token::authority = listing,
        token::token_program = token_program,
    )]
    pub item_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CaptureSale<'info> {
    pub settle: Settle<'info>,
    #[account(
        mut,
        seeds = [LISTING_SEED, listing.seller.as_ref(), &listing.listing_id.to_le_bytes()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, Listing>,
    #[account(address = listing.item_mint)]
    pub item_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [ITEM_SEED, listing.key().as_ref()], bump)]
    pub item_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = item_mint)]
    pub buyer_item_token: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Delist<'info> {
    #[account(address = listing.seller @ HoldbackError::Unauthorized)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [LISTING_SEED, listing.seller.as_ref(), &listing.listing_id.to_le_bytes()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, Listing>,
    #[account(address = listing.item_mint)]
    pub item_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [ITEM_SEED, listing.key().as_ref()], bump)]
    pub item_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = item_mint, token::authority = seller)]
    pub seller_item_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub item_mint: Pubkey,
    pub listing_id: u64,
    /// Lowest price the seller will capture.
    pub reserve: u64,
    pub status: ListingStatus,
    pub buyer: Pubkey,
    pub price: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ListingStatus {
    Open,
    Sold,
    Delisted,
}

#[account]
#[derive(InitSpace)]
pub struct Payment {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub payment_id: u64,
    pub amount: u64,
    pub created_at: i64,
    /// End of the hold window. Before it: reclaim/dispute. After it: release.
    pub release_at: i64,
    pub disputed_at: i64,
    pub dispute_reason: [u8; 32],
    pub refunded: u64,
    pub status: Status,
    pub policy: Policy,
    pub bump: u8,
    pub vault_bump: u8,
}

/// A pricing model expressed as configuration. `preset` is a label for
/// clients (1 guarantee, 2 pay-if-useful, 3 affiliate, 4 pay-it-forward);
/// the program only enforces the fields.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Policy {
    pub preset: u8,
    pub window_secs: i64,
    pub buyer_can_reclaim: bool,
    /// Pubkey::default() means no disputes.
    pub judge: Pubkey,
    pub dispute_timeout_secs: i64,
    /// Bids and offers: if the merchant has not captured by the end of the
    /// window, the buyer takes the money back (it is never auto-released).
    pub refund_if_uncaptured: bool,
    /// The listing this hold bids on, or Pubkey::default().
    pub listing: Pubkey,
    #[max_len(MAX_SPLITS)]
    pub splits: Vec<Split>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Split {
    pub recipient: Pubkey,
    pub bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Status {
    Held,
    Disputed,
    Released,
    Refunded,
}

// ------------------------------------------------------------------ events

#[event]
pub struct Authorized {
    pub payment: Pubkey,
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub release_at: i64,
    pub preset: u8,
}

#[event]
pub struct Disputed {
    pub payment: Pubkey,
    pub reason: [u8; 32],
}

#[event]
pub struct Settled {
    pub payment: Pubkey,
    pub status: Status,
    pub refunded: u64,
    pub to_merchant: u64,
    pub to_splits: u64,
}

#[event]
pub struct Listed {
    pub listing: Pubkey,
    pub item_mint: Pubkey,
    pub reserve: u64,
}

#[event]
pub struct Sold {
    pub listing: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum HoldbackError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Window and timeouts must be positive")]
    InvalidWindow,
    #[msg("At most 3 split recipients")]
    TooManySplits,
    #[msg("Split basis points exceed 10000")]
    SplitsExceedTotal,
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Payment is not held")]
    NotHeld,
    #[msg("Payment is not disputed")]
    NotDisputed,
    #[msg("Payment is already settled")]
    AlreadySettled,
    #[msg("This policy does not let the buyer reclaim")]
    ReclaimNotAllowed,
    #[msg("This policy has no judge, so it cannot be disputed")]
    NoJudge,
    #[msg("The hold window has closed")]
    WindowClosed,
    #[msg("The window is still open")]
    WindowOpen,
    #[msg("Split token accounts do not match the policy")]
    SplitAccountsMismatch,
    #[msg("Token account owner does not match the payment")]
    WrongTokenOwner,
    #[msg("This hold must be captured by the merchant; it is never auto-released")]
    CaptureRequired,
    #[msg("Capture must be positive and at most the held amount")]
    CaptureTooLarge,
    #[msg("This hold is not a bid on this listing")]
    WrongListing,
    #[msg("Listing is not open")]
    ListingClosed,
    #[msg("Price is below the seller's reserve")]
    BelowReserve,
}
