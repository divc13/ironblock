//! Ironblock NEP-245 multi-token contract.
//!
//! One contract holds every in-game item type. The genesis supply of each item is
//! minted exactly once to the game treasury. There is no public mint and no burn:
//! the only supply change after genesis is none, which keeps the game's ledger and
//! the on-chain supply in lockstep.
//!
//! Optional NEP-245 extensions that are intentionally **not** implemented:
//! * Approval management: the game server transfers from the treasury, and player
//!   withdrawals are settled as direct transfers. `approval` / `approvals` must be
//!   `null`; supplying an approval panics.
//! * Storage management / receiver registration: transfers are direct, matching the
//!   hackathon requirement. See `README.md` for the storage tradeoff.
//! * Burn: the item supply is fixed at genesis.
//!
//! `mt_transfer_call` and `mt_batch_transfer_call` are implemented. The receiver
//! must implement `mt_on_transfer`; the contract rolls unused tokens back with
//! `mt_resolve_transfer`.

mod icons;

use near_sdk::{
    collections::LookupMap,
    env,
    json_types::{U128, U64},
    near,
    serde::Serialize,
    serde_json,
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// NEP-245 token identifier. Item IDs are stable, human-readable strings such as
/// `iron_ore`. They must never be renamed once the game economy is live.
pub type TokenId = String;

const EVENT_STANDARD: &str = "nep245";
const EVENT_VERSION: &str = "1.0.0";
const EVENT_PREFIX: &str = "EVENT_JSON:";

/// Every NEP-245 transfer requires a 1 yoctoNEAR security deposit.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Gas reserved for the receiver's `mt_on_transfer` call.
const GAS_FOR_MT_ON_TRANSFER: Gas = Gas::from_tgas(20);
/// Gas reserved for the settlement callback.
const GAS_FOR_MT_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
/// Minimum gas the caller must attach to a `*_transfer_call` method.
const MIN_GAS_FOR_TRANSFER_CALL: Gas = Gas::from_tgas(40);
/// Cap on the receiver's returned data. A larger/malformed response results in a
/// full refund rather than a callback panic.
const MAX_CALLBACK_RESULT_BYTES: usize = 1_000_000;

/// Static definition of one item type. Metadata and supply are compiled into the
/// contract so a compromised owner key cannot alter item definitions or supplies.
#[derive(Clone, Debug)]
pub struct ItemDefinition {
    pub token_id: &'static str,
    pub name: &'static str,
    pub symbol: &'static str,
    pub description: &'static str,
    pub icon: &'static str,
    pub genesis_supply: u128,
}

pub const ITEMS: [ItemDefinition; 11] = [
    ItemDefinition {
        token_id: "iron_ore",
        name: "Iron Ore",
        symbol: "IORE",
        description: "Raw iron ore mined from the hills around Ironblock.",
        icon: icons::IRON_ORE_ICON,
        genesis_supply: 100_000,
    },
    ItemDefinition {
        token_id: "iron_ingot",
        name: "Iron Ingot",
        symbol: "IING",
        description: "Smelted iron ingot, ready for tools and construction.",
        icon: icons::IRON_INGOT_ICON,
        genesis_supply: 25_000,
    },
    ItemDefinition {
        token_id: "grain",
        name: "Grain",
        symbol: "GRN",
        description: "Threshed grain from the valley farms.",
        icon: icons::GRAIN_ICON,
        genesis_supply: 100_000,
    },
    ItemDefinition {
        token_id: "flour",
        name: "Flour",
        symbol: "FLR",
        description: "Stone-ground flour milled from valley grain.",
        icon: icons::FLOUR_ICON,
        genesis_supply: 25_000,
    },
    ItemDefinition {
        token_id: "timber",
        name: "Timber",
        symbol: "TMB",
        description: "Rough timber felled in the Ironblock woods.",
        icon: icons::TIMBER_ICON,
        genesis_supply: 100_000,
    },
    ItemDefinition {
        token_id: "plank",
        name: "Plank",
        symbol: "PLK",
        description: "Sawn plank, dressed for building.",
        icon: icons::PLANK_ICON,
        genesis_supply: 25_000,
    },
    ItemDefinition {
        token_id: "wool",
        name: "Wool",
        symbol: "WOL",
        description: "Fleece sheared from the town flock.",
        icon: icons::WOOL_ICON,
        genesis_supply: 100_000,
    },
    ItemDefinition {
        token_id: "cloth",
        name: "Cloth",
        symbol: "CLT",
        description: "Woven cloth spun from local wool.",
        icon: icons::CLOTH_ICON,
        genesis_supply: 25_000,
    },
    ItemDefinition {
        token_id: "pickaxe",
        name: "Pickaxe",
        symbol: "PCK",
        description: "A sturdy iron pickaxe for mining ore.",
        icon: icons::PICKAXE_ICON,
        genesis_supply: 1_000,
    },
    ItemDefinition {
        token_id: "hoe",
        name: "Hoe",
        symbol: "HOE",
        description: "A farming hoe for tending crops.",
        icon: icons::HOE_ICON,
        genesis_supply: 1_000,
    },
    ItemDefinition {
        token_id: "axe",
        name: "Axe",
        symbol: "AXE",
        description: "A woodcutter's axe for felling timber.",
        icon: icons::AXE_ICON,
        genesis_supply: 1_000,
    },
];

fn item_definition(token_id: &str) -> Option<&'static ItemDefinition> {
    ITEMS.iter().find(|item| item.token_id == token_id)
}

/// NEP-245 core `Token` view object. `owner_id` is only meaningful for tokens with
/// a unique owner (supply 1); Ironblock items are fungible-like, so it is `None`
/// for `mt_token` / `mt_tokens`. `mt_tokens_for_owner` reports the queried account
/// for convenience.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: Option<AccountId>,
}

/// Current NEP-245 metadata extension: contract-level metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractMetadata {
    pub spec: String,
    pub name: String,
}

/// Current NEP-245 metadata extension: base token metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    /// Serialized as a decimal string by NEP-245. Ironblock uses 0 decimals.
    pub decimals: Option<U64>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub copies: Option<U64>,
}

/// Current NEP-245 metadata extension: token-instance metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<U64>,
    pub expires_at: Option<U64>,
    pub starts_at: Option<U64>,
    pub updated_at: Option<U64>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// Combined base + instance metadata, as returned by `mt_metadata_token_all`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenMetadataAll {
    pub base: BaseMetadata,
    pub token: TokenMetadata,
}

/// Convenience view used by the game server and simple clients. This is not a
/// NEP-245 standard method, but it flattens the two metadata layers into one
/// object and includes the current supply.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemMetadata {
    pub token_id: TokenId,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub icon: String,
    pub decimals: u8,
    pub supply: U128,
}

/// Contract configuration, exposed for operators and the game server.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractConfig {
    pub owner_id: AccountId,
    pub treasury_id: AccountId,
    pub proposed_owner_id: Option<AccountId>,
    pub genesis_minted: bool,
    pub token_count: u32,
}

/// NEP-245 approval tuple (`[owner_id, approval_id]`). Approval management is not
/// supported by this contract, so any non-null value is rejected.
#[near(serializers = [json])]
pub struct Approval(pub AccountId, pub u64);

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MintEventData {
    owner_id: AccountId,
    token_ids: Vec<TokenId>,
    amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TransferEventData {
    #[serde(skip_serializing_if = "Option::is_none")]
    authorized_id: Option<AccountId>,
    old_owner_id: AccountId,
    new_owner_id: AccountId,
    token_ids: Vec<TokenId>,
    amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct EventJson<T> {
    standard: &'static str,
    version: &'static str,
    event: &'static str,
    data: Vec<T>,
}

fn emit_event<T: Serialize>(event: &'static str, data: Vec<T>) {
    let payload = EventJson {
        standard: EVENT_STANDARD,
        version: EVENT_VERSION,
        event,
        data,
    };
    let json = serde_json::to_string(&payload)
        .unwrap_or_else(|_| env::panic_str("Failed to serialize NEP-297 event"));
    env::log_str(&format!("{EVENT_PREFIX}{json}"));
}

fn emit_mint(owner_id: &AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, memo: Option<String>) {
    emit_event(
        "mt_mint",
        vec![MintEventData {
            owner_id: owner_id.clone(),
            token_ids,
            amounts,
            memo,
        }],
    );
}

fn emit_transfer(
    old_owner_id: &AccountId,
    new_owner_id: &AccountId,
    token_ids: Vec<TokenId>,
    amounts: Vec<U128>,
    memo: Option<String>,
) {
    if token_ids.is_empty() {
        return;
    }
    emit_event(
        "mt_transfer",
        vec![TransferEventData {
            authorized_id: None,
            old_owner_id: old_owner_id.clone(),
            new_owner_id: new_owner_id.clone(),
            token_ids,
            amounts,
            memo,
        }],
    );
}

/// Storage layout:
/// * `balances`: `(account_id, token_id) -> balance`, removed when zero.
/// * `supplies`: `token_id -> circulating supply`, set once at genesis.
///
/// Item metadata and genesis supplies live in compile-time constants in this
/// contract, not in mutable state.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    treasury_id: AccountId,
    proposed_owner_id: Option<AccountId>,
    genesis_minted: bool,
    balances: LookupMap<(AccountId, TokenId), u128>,
    supplies: LookupMap<TokenId, u128>,
}

#[near]
impl Contract {
    /// Initialize a new contract. `owner_id` controls the one-time genesis mint;
    /// `treasury_id` receives the entire genesis supply. They may be the same
    /// account on testnet, but separating them is recommended.
    #[init]
    pub fn new(owner_id: AccountId, treasury_id: AccountId) -> Self {
        Self {
            owner_id,
            treasury_id,
            proposed_owner_id: None,
            genesis_minted: false,
            balances: LookupMap::new(b"b"),
            supplies: LookupMap::new(b"s"),
        }
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// Mint each item's fixed genesis supply to the treasury exactly once.
    /// Only the owner can call this, and no public mint path exists.
    pub fn mint_genesis(&mut self) {
        self.assert_owner();
        assert!(
            !self.genesis_minted,
            "Genesis supply has already been minted"
        );

        let mut token_ids = Vec::with_capacity(ITEMS.len());
        let mut amounts = Vec::with_capacity(ITEMS.len());

        for item in ITEMS.iter() {
            let token_id = item.token_id.to_string();
            assert_eq!(
                self.supplies.get(&token_id).unwrap_or(0),
                0,
                "Supply is already initialized for this token"
            );

            let balance_key = (self.treasury_id.clone(), token_id.clone());
            assert!(
                !self.balances.contains_key(&balance_key),
                "Treasury already has a balance for this token"
            );

            self.supplies.insert(&token_id, &item.genesis_supply);
            self.balances.insert(&balance_key, &item.genesis_supply);
            token_ids.push(token_id);
            amounts.push(U128(item.genesis_supply));
        }

        self.genesis_minted = true;
        emit_mint(
            &self.treasury_id,
            token_ids,
            amounts,
            Some("Ironblock genesis supply".to_string()),
        );
    }

    /// Start a two-step ownership transfer.
    pub fn propose_owner(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        self.proposed_owner_id = Some(new_owner_id);
    }

    /// Accept a pending ownership transfer. Only the proposed account can call.
    pub fn accept_owner(&mut self) {
        let proposed = self
            .proposed_owner_id
            .clone()
            .unwrap_or_else(|| env::panic_str("No ownership proposal is pending"));
        assert_eq!(
            env::predecessor_account_id(),
            proposed,
            "Only the proposed owner can accept ownership"
        );
        self.owner_id = proposed;
        self.proposed_owner_id = None;
    }

    // ---------------------------------------------------------------------
    // NEP-245 core: transfers
    // ---------------------------------------------------------------------

    /// NEP-245 `mt_transfer`. The caller must be the owner of `amount` tokens.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
    ) {
        self.assert_one_yocto();
        assert!(
            approval.is_none(),
            "Approval management is not supported; approval must be null"
        );

        let sender_id = env::predecessor_account_id();
        self.transfer_internal(
            &sender_id,
            &receiver_id,
            &[token_id],
            &[amount],
            memo,
        );
    }

    /// NEP-245 `mt_batch_transfer`.
    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
    ) {
        self.assert_one_yocto();
        self.assert_no_approvals(approvals.as_deref(), token_ids.len());

        let sender_id = env::predecessor_account_id();
        self.transfer_internal(&sender_id, &receiver_id, &token_ids, &amounts, memo);
    }

    /// NEP-245 `mt_transfer_call`. Transfers the tokens, calls
    /// `mt_on_transfer` on the receiver, then settles any unused tokens via
    /// `mt_resolve_transfer`.
    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        self.assert_one_yocto();
        assert!(
            approval.is_none(),
            "Approval management is not supported; approval must be null"
        );
        self.assert_transfer_call_gas();

        let sender_id = env::predecessor_account_id();
        let token_ids = vec![token_id];
        let amounts = vec![amount];
        self.transfer_internal(
            &sender_id,
            &receiver_id,
            &token_ids,
            &amounts,
            memo,
        );

        transfer_call_promise(sender_id, receiver_id, token_ids, amounts, msg)
    }

    /// NEP-245 `mt_batch_transfer_call`.
    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        self.assert_one_yocto();
        self.assert_no_approvals(approvals.as_deref(), token_ids.len());
        self.assert_transfer_call_gas();

        let sender_id = env::predecessor_account_id();
        self.transfer_internal(&sender_id, &receiver_id, &token_ids, &amounts, memo);

        transfer_call_promise(sender_id, receiver_id, token_ids, amounts, msg)
    }

    /// Settlement callback for `mt_transfer_call` / `mt_batch_transfer_call`.
    /// Reads the receiver's returned list of unused amounts directly, so a
    /// malformed or oversized response is treated as a failed call and refunded
    /// instead of panicking and leaving tokens with the receiver.
    ///
    /// Returns the amount actually spent by the receiver for each token.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
    ) -> Vec<U128> {
        let result = match env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES) {
            Ok(bytes) => serde_json::from_slice::<Vec<U128>>(&bytes)
                .map_err(|_| PromiseError::Failed),
            Err(error) => Err(error),
        };

        self.resolve_transfer(sender_id, receiver_id, token_ids, amounts, result)
    }

    // ---------------------------------------------------------------------
    // NEP-245 core: views
    // ---------------------------------------------------------------------

    /// NEP-245 `mt_balance_of`. Unknown token IDs return zero, matching the
    /// common multi-token convention.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(self.balance_of(&account_id, &token_id))
    }

    /// NEP-245 `mt_batch_balance_of`.
    pub fn mt_batch_balance_of(
        &self,
        account_id: AccountId,
        token_ids: Vec<TokenId>,
    ) -> Vec<U128> {
        token_ids
            .iter()
            .map(|token_id| U128(self.balance_of(&account_id, token_id)))
            .collect()
    }

    /// NEP-245 core supply view. Returns `None` for unknown token IDs.
    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        if item_definition(&token_id).is_none() {
            return None;
        }
        Some(U128(self.supplies.get(&token_id).unwrap_or(0)))
    }

    /// NEP-245 core batch supply view.
    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids
            .iter()
            .map(|token_id| {
                item_definition(token_id).map(|_| U128(self.supplies.get(token_id).unwrap_or(0)))
            })
            .collect()
    }

    /// NEP-245 `mt_token`. Unknown token IDs yield `None` in the corresponding
    /// position.
    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .iter()
            .map(|token_id| {
                item_definition(token_id).map(|_| Token {
                    token_id: token_id.clone(),
                    owner_id: None,
                })
            })
            .collect()
    }

    // ---------------------------------------------------------------------
    // NEP-245 enumeration
    // ---------------------------------------------------------------------

    /// List all token IDs known to the contract. Paginated for interface
    /// compatibility; Ironblock has a fixed, small token set.
    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let (start, end) = page_bounds(ITEMS.len(), from_index, limit);
        ITEMS[start..end]
            .iter()
            .map(|item| Token {
                token_id: item.token_id.to_string(),
                owner_id: None,
            })
            .collect()
    }

    /// List token IDs with a non-zero balance for `account_id`. This scans the
    /// fixed 11-item set, so gas is bounded and enumeration cannot grow with
    /// state.
    pub fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        let owned: Vec<Token> = ITEMS
            .iter()
            .filter(|item| self.balance_of(&account_id, item.token_id) > 0)
            .map(|item| Token {
                token_id: item.token_id.to_string(),
                owner_id: Some(account_id.clone()),
            })
            .collect();
        let (start, end) = page_bounds(owned.len(), from_index, limit);
        owned[start..end].to_vec()
    }

    // ---------------------------------------------------------------------
    // NEP-245 metadata extension (current spec)
    // ---------------------------------------------------------------------

    /// Current NEP-245 metadata interface: contract metadata.
    pub fn mt_metadata_contract(&self) -> ContractMetadata {
        ContractMetadata {
            spec: "mt-1.0.0".to_string(),
            name: "Ironblock Items".to_string(),
        }
    }

    /// Current NEP-245 metadata interface: combined metadata for existing tokens.
    pub fn mt_metadata_token_all(&self, token_ids: Vec<TokenId>) -> Vec<TokenMetadataAll> {
        token_ids
            .iter()
            .filter_map(|token_id| {
                item_definition(token_id).map(|item| TokenMetadataAll {
                    base: base_metadata(item),
                    token: token_metadata(item),
                })
            })
            .collect()
    }

    /// Current NEP-245 metadata interface: instance metadata for existing tokens.
    pub fn mt_metadata_token_by_token_id(
        &self,
        token_ids: Vec<TokenId>,
    ) -> Vec<TokenMetadata> {
        token_ids
            .iter()
            .filter_map(|token_id| item_definition(token_id).map(token_metadata))
            .collect()
    }

    /// Current NEP-245 metadata interface: base metadata by token ID.
    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<TokenId>) -> Vec<BaseMetadata> {
        token_ids
            .iter()
            .filter_map(|token_id| item_definition(token_id).map(base_metadata))
            .collect()
    }

    /// Current NEP-245 metadata interface: base metadata by metadata ID. For
    /// Ironblock the base metadata ID is identical to the token ID.
    pub fn mt_metadata_base_by_metadata_id(
        &self,
        base_metadata_ids: Vec<String>,
    ) -> Vec<BaseMetadata> {
        base_metadata_ids
            .iter()
            .filter_map(|metadata_id| item_definition(metadata_id).map(base_metadata))
            .collect()
    }

    /// NEP-245 enumeration + metadata: all base metadata, paginated.
    pub fn mt_tokens_base_metadata_all(
        &self,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<BaseMetadata> {
        let (start, end) = page_bounds(ITEMS.len(), from_index, limit);
        ITEMS[start..end].iter().map(base_metadata).collect()
    }

    /// Convenience one-object metadata view. Not a standard NEP-245 method.
    pub fn mt_metadata(&self, token_id: TokenId) -> Option<ItemMetadata> {
        item_definition(&token_id).map(|item| self.item_metadata(item))
    }

    /// Convenience batch metadata view. Unknown token IDs yield `null` in place.
    pub fn mt_batch_metadata(&self, token_ids: Vec<TokenId>) -> Vec<Option<ItemMetadata>> {
        token_ids
            .iter()
            .map(|token_id| {
                item_definition(token_id).map(|item| self.item_metadata(item))
            })
            .collect()
    }

    // ---------------------------------------------------------------------
    // Operator / game-server convenience views
    // ---------------------------------------------------------------------

    pub fn get_config(&self) -> ContractConfig {
        ContractConfig {
            owner_id: self.owner_id.clone(),
            treasury_id: self.treasury_id.clone(),
            proposed_owner_id: self.proposed_owner_id.clone(),
            genesis_minted: self.genesis_minted,
            token_count: ITEMS.len() as u32,
        }
    }

    pub fn get_items(&self) -> Vec<ItemMetadata> {
        ITEMS.iter().map(|item| self.item_metadata(item)).collect()
    }

    pub fn get_item(&self, token_id: TokenId) -> Option<ItemMetadata> {
        item_definition(&token_id).map(|item| self.item_metadata(item))
    }
}

impl Contract {
    /// Settlement logic separated from the callback host-function read so it can
    /// be unit tested directly.
    fn resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        result: Result<Vec<U128>, PromiseError>,
    ) -> Vec<U128> {
        assert_eq!(
            token_ids.len(),
            amounts.len(),
            "token_ids and amounts must have the same length"
        );

        let unused = match result {
            Ok(values) if values.len() == amounts.len() => values,
            _ => amounts.clone(),
        };

        let mut refund_token_ids = Vec::new();
        let mut refund_amounts = Vec::new();
        let mut spent = Vec::with_capacity(amounts.len());

        for ((token_id, amount), unused_amount) in
            token_ids.iter().zip(amounts.iter()).zip(unused.iter())
        {
            let requested = amount.0;
            let attempted_refund = unused_amount.0.min(requested);
            let receiver_balance = self.balance_of(&receiver_id, token_id);
            let refund = attempted_refund.min(receiver_balance);

            if refund > 0 {
                self.set_balance(&receiver_id, token_id, receiver_balance - refund);
                let sender_balance = self.balance_of(&sender_id, token_id);
                let new_sender_balance = sender_balance
                    .checked_add(refund)
                    .unwrap_or_else(|| env::panic_str("Balance overflow while refunding"));
                self.set_balance(&sender_id, token_id, new_sender_balance);
                refund_token_ids.push(token_id.clone());
                refund_amounts.push(U128(refund));
            }

            spent.push(U128(requested - refund));
        }

        emit_transfer(
            &receiver_id,
            &sender_id,
            refund_token_ids,
            refund_amounts,
            Some("transfer_call refund".to_string()),
        );

        spent
    }

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only the contract owner can call this method"
        );
    }

    fn assert_one_yocto(&self) {
        assert_eq!(
            env::attached_deposit(),
            ONE_YOCTO,
            "Exactly 1 yoctoNEAR must be attached"
        );
    }

    fn assert_transfer_call_gas(&self) {
        assert!(
            env::prepaid_gas() >= MIN_GAS_FOR_TRANSFER_CALL,
            "At least 40 Tgas must be attached to a transfer_call"
        );
    }

    fn assert_no_approvals(&self, approvals: Option<&[Option<Approval>]>, token_count: usize) {
        if let Some(approvals) = approvals {
            assert_eq!(
                approvals.len(),
                token_count,
                "approvals must have the same length as token_ids"
            );
            assert!(
                approvals.iter().all(Option::is_none),
                "Approval management is not supported; approvals must be null"
            );
        }
    }

    fn balance_of(&self, account_id: &AccountId, token_id: &str) -> u128 {
        self.balances
            .get(&(account_id.clone(), token_id.to_string()))
            .unwrap_or(0)
    }

    fn set_balance(&mut self, account_id: &AccountId, token_id: &str, amount: u128) {
        let key = (account_id.clone(), token_id.to_string());
        if amount == 0 {
            self.balances.remove(&key);
        } else {
            self.balances.insert(&key, &amount);
        }
    }

    /// Validate and apply a transfer. Storage changes are only made after all
    /// checks pass. Duplicate token IDs are combined for the balance checks and
    /// then applied in order.
    fn transfer_internal(
        &mut self,
        sender_id: &AccountId,
        receiver_id: &AccountId,
        token_ids: &[TokenId],
        amounts: &[U128],
        memo: Option<String>,
    ) {
        assert_eq!(
            token_ids.len(),
            amounts.len(),
            "token_ids and amounts must have the same length"
        );
        assert!(!token_ids.is_empty(), "Empty transfer");
        assert_ne!(
            sender_id, receiver_id,
            "Sender and receiver must be different"
        );

        // Aggregate required amounts per token ID so duplicate IDs cannot bypass
        // the balance check.
        let mut required: Vec<(TokenId, u128)> = Vec::new();
        for (token_id, amount) in token_ids.iter().zip(amounts.iter()) {
            assert!(
                amount.0 > 0,
                "Amount must be greater than zero for token {token_id}"
            );
            assert!(
                item_definition(token_id).is_some(),
                "Unknown token ID: {token_id}"
            );
            if let Some((_, total)) = required.iter_mut().find(|(id, _)| id == token_id) {
                *total = total
                    .checked_add(amount.0)
                    .unwrap_or_else(|| env::panic_str("Amount overflow"));
            } else {
                required.push((token_id.clone(), amount.0));
            }
        }

        for (token_id, total) in &required {
            let sender_balance = self.balance_of(sender_id, token_id);
            assert!(
                sender_balance >= *total,
                "Insufficient {token_id} balance: have {sender_balance}, need {total}"
            );
            self.balance_of(receiver_id, token_id)
                .checked_add(*total)
                .unwrap_or_else(|| env::panic_str("Receiver balance overflow"));
        }

        for (token_id, amount) in token_ids.iter().zip(amounts.iter()) {
            let sender_balance = self.balance_of(sender_id, token_id);
            self.set_balance(sender_id, token_id, sender_balance - amount.0);
            let receiver_balance = self.balance_of(receiver_id, token_id);
            self.set_balance(receiver_id, token_id, receiver_balance + amount.0);
        }

        emit_transfer(
            sender_id,
            receiver_id,
            token_ids.to_vec(),
            amounts.to_vec(),
            memo,
        );
    }

    fn item_metadata(&self, item: &ItemDefinition) -> ItemMetadata {
        ItemMetadata {
            token_id: item.token_id.to_string(),
            name: item.name.to_string(),
            symbol: item.symbol.to_string(),
            description: item.description.to_string(),
            icon: item.icon.to_string(),
            decimals: 0,
            supply: U128(self.supplies.get(&item.token_id.to_string()).unwrap_or(0)),
        }
    }
}

fn base_metadata(item: &ItemDefinition) -> BaseMetadata {
    BaseMetadata {
        name: item.name.to_string(),
        id: item.token_id.to_string(),
        symbol: Some(item.symbol.to_string()),
        icon: Some(item.icon.to_string()),
        decimals: Some(U64(0)),
        base_uri: None,
        reference: None,
        reference_hash: None,
        copies: None,
    }
}

fn token_metadata(item: &ItemDefinition) -> TokenMetadata {
    TokenMetadata {
        title: Some(item.name.to_string()),
        description: Some(item.description.to_string()),
        media: Some(item.icon.to_string()),
        media_hash: None,
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}

fn page_bounds(
    len: usize,
    from_index: Option<U128>,
    limit: Option<u32>,
) -> (usize, usize) {
    let start = from_index
        .map(|index| usize::try_from(index.0).unwrap_or(usize::MAX))
        .unwrap_or(0)
        .min(len);
    let end = match limit {
        Some(limit) => start.saturating_add(limit as usize).min(len),
        None => len,
    };
    (start, end)
}

/// Build the receiver call and settlement callback for `*_transfer_call`.
fn transfer_call_promise(
    sender_id: AccountId,
    receiver_id: AccountId,
    token_ids: Vec<TokenId>,
    amounts: Vec<U128>,
    msg: String,
) -> Promise {
    let previous_owner_ids = vec![sender_id.clone(); token_ids.len()];
    let receiver_args = serde_json::to_vec(&serde_json::json!({
        "sender_id": sender_id,
        "previous_owner_ids": previous_owner_ids,
        "token_ids": token_ids,
        "amounts": amounts,
        "msg": msg,
    }))
    .unwrap_or_else(|_| env::panic_str("Failed to serialize mt_on_transfer arguments"));

    let resolver_args = serde_json::to_vec(&serde_json::json!({
        "sender_id": sender_id,
        "receiver_id": receiver_id,
        "token_ids": token_ids,
        "amounts": amounts,
    }))
    .unwrap_or_else(|_| env::panic_str("Failed to serialize mt_resolve_transfer arguments"));

    Promise::new(receiver_id)
        .function_call(
            "mt_on_transfer".to_string(),
            receiver_args,
            NearToken::from_yoctonear(0),
            GAS_FOR_MT_ON_TRANSFER,
        )
        .then(Promise::new(env::current_account_id()).function_call(
            "mt_resolve_transfer".to_string(),
            resolver_args,
            NearToken::from_yoctonear(0),
            GAS_FOR_MT_RESOLVE_TRANSFER,
        ))
}

#[cfg(test)]
mod tests;
