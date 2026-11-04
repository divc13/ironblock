#![allow(deprecated)]

use super::*;
use near_sdk::test_utils::{accounts, get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::serde_json::Value;
use near_sdk::{testing_env, PromiseError, PromiseResult};

fn contract_id() -> AccountId {
    "items.ironblock.testnet".parse().unwrap()
}

fn owner_id() -> AccountId {
    "owner.ironblock.testnet".parse().unwrap()
}

fn treasury_id() -> AccountId {
    "treasury.ironblock.testnet".parse().unwrap()
}

fn alice() -> AccountId {
    accounts(0)
}

fn bob() -> AccountId {
    accounts(1)
}

fn implicit_account() -> AccountId {
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        .parse()
        .unwrap()
}

fn set_env(predecessor: &AccountId, deposit_yocto: u128, prepaid_tgas: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(contract_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .prepaid_gas(Gas::from_tgas(prepaid_tgas));
    testing_env!(builder.build());
}

fn setup() -> Contract {
    set_env(&owner_id(), 0, 100);
    Contract::new(owner_id(), treasury_id())
}

fn setup_minted() -> Contract {
    let mut contract = setup();
    set_env(&owner_id(), 0, 100);
    contract.mint_genesis();
    contract
}

fn event_json() -> Value {
    let logs = get_logs();
    let event = logs
        .iter()
        .rev()
        .find(|line| line.starts_with(EVENT_PREFIX))
        .expect("expected a NEP-297 event");
    serde_json::from_str(event.strip_prefix(EVENT_PREFIX).unwrap()).unwrap()
}

fn total_balance(contract: &Contract, accounts: &[AccountId], token_id: &str) -> u128 {
    accounts
        .iter()
        .map(|account| {
            contract
                .mt_balance_of(account.clone(), token_id.to_string())
                .0
        })
        .sum()
}

#[test]
fn genesis_supply_is_minted_once_to_treasury() {
    let mut contract = setup();
    assert!(!contract.get_config().genesis_minted);
    assert_eq!(contract.mt_supply("iron_ore".to_string()), Some(U128(0)));

    set_env(&owner_id(), 0, 100);
    contract.mint_genesis();

    assert!(contract.get_config().genesis_minted);
    assert_eq!(contract.get_config().treasury_id, treasury_id());
    assert_eq!(contract.get_config().owner_id, owner_id());

    let mut total = 0u128;
    for item in ITEMS.iter() {
        assert_eq!(
            contract.mt_supply(item.token_id.to_string()),
            Some(U128(item.genesis_supply)),
            "unexpected supply for {}",
            item.token_id
        );
        assert_eq!(
            contract
                .mt_balance_of(treasury_id(), item.token_id.to_string())
                .0,
            item.genesis_supply,
            "treasury balance for {}",
            item.token_id
        );
        total += item.genesis_supply;
    }
    assert_eq!(total, 503_000);

    let event = event_json();
    assert_eq!(event["standard"], "nep245");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "mt_mint");
    assert_eq!(event["data"][0]["owner_id"], treasury_id().as_str());
    assert_eq!(event["data"][0]["token_ids"].as_array().unwrap().len(), 11);
    assert_eq!(event["data"][0]["amounts"].as_array().unwrap().len(), 11);
}

#[test]
fn treasury_can_transfer_single_token_type() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        alice(),
        "iron_ore".to_string(),
        U128(1_500),
        None,
        Some("withdrawal".to_string()),
    );

    assert_eq!(
        contract
            .mt_balance_of(treasury_id(), "iron_ore".to_string())
            .0,
        98_500
    );
    assert_eq!(
        contract
            .mt_balance_of(alice(), "iron_ore".to_string())
            .0,
        1_500
    );
    assert_eq!(
        contract.mt_supply("iron_ore".to_string()),
        Some(U128(100_000))
    );

    let event = event_json();
    assert_eq!(event["event"], "mt_transfer");
    assert_eq!(event["data"][0]["old_owner_id"], treasury_id().as_str());
    assert_eq!(event["data"][0]["new_owner_id"], alice().as_str());
    assert_eq!(event["data"][0]["token_ids"][0], "iron_ore");
    assert_eq!(event["data"][0]["amounts"][0], "1500");
    assert_eq!(event["data"][0]["memo"], "withdrawal");
}

#[test]
fn treasury_can_batch_transfer_and_balances_update() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    contract.mt_batch_transfer(
        bob(),
        vec![
            "iron_ore".to_string(),
            "grain".to_string(),
            "axe".to_string(),
        ],
        vec![U128(2_000), U128(3_000), U128(5)],
        None,
        None,
    );

    assert_eq!(
        contract
            .mt_balance_of(bob(), "iron_ore".to_string())
            .0,
        2_000
    );
    assert_eq!(contract.mt_balance_of(bob(), "grain".to_string()).0, 3_000);
    assert_eq!(contract.mt_balance_of(bob(), "axe".to_string()).0, 5);

    let event = event_json();
    assert_eq!(event["event"], "mt_transfer");
    assert_eq!(event["data"][0]["token_ids"].as_array().unwrap().len(), 3);
    assert_eq!(event["data"][0]["amounts"][0], "2000");
    assert_eq!(event["data"][0]["amounts"][1], "3000");
    assert_eq!(event["data"][0]["amounts"][2], "5");
}

#[test]
fn supply_is_conserved_across_transfers() {
    let mut contract = setup_minted();

    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        alice(),
        "wool".to_string(),
        U128(12_345),
        None,
        None,
    );
    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        bob(),
        "wool".to_string(),
        U128(1_000),
        None,
        None,
    );
    set_env(&alice(), 1, 100);
    contract.mt_transfer(
        bob(),
        "wool".to_string(),
        U128(2_345),
        None,
        None,
    );

    assert_eq!(
        total_balance(&contract, &[treasury_id(), alice(), bob()], "wool"),
        100_000
    );

    for item in ITEMS.iter() {
        let supply = contract
            .mt_supply(item.token_id.to_string())
            .unwrap()
            .0;
        let accounted =
            total_balance(&contract, &[treasury_id(), alice(), bob()], item.token_id);
        assert_eq!(accounted, supply, "supply not conserved for {}", item.token_id);
    }
}

#[test]
#[should_panic(expected = "Only the contract owner can call this method")]
fn unauthorized_mint_fails() {
    let mut contract = setup();
    set_env(&alice(), 0, 100);
    contract.mint_genesis();
}

#[test]
#[should_panic(expected = "Only the contract owner can call this method")]
fn owner_cannot_be_impersonated_after_genesis() {
    let mut contract = setup_minted();
    set_env(&bob(), 0, 100);
    contract.mint_genesis();
}

#[test]
#[should_panic(expected = "Genesis supply has already been minted")]
fn genesis_mint_is_exactly_once() {
    let mut contract = setup_minted();
    set_env(&owner_id(), 0, 100);
    contract.mint_genesis();
}

#[test]
#[should_panic(expected = "Insufficient iron_ore balance")]
fn unauthorized_transfer_fails() {
    let mut contract = setup_minted();
    set_env(&alice(), 1, 100);
    contract.mt_transfer(
        bob(),
        "iron_ore".to_string(),
        U128(1),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Exactly 1 yoctoNEAR must be attached")]
fn transfer_without_one_yocto_fails() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 0, 100);
    contract.mt_transfer(
        alice(),
        "iron_ore".to_string(),
        U128(1),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Unknown token ID")]
fn unknown_token_transfer_fails() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        alice(),
        "mithril".to_string(),
        U128(1),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Approval management is not supported")]
fn approval_transfer_is_rejected() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        alice(),
        "iron_ore".to_string(),
        U128(1),
        Some(Approval(alice(), 7)),
        None,
    );
}

#[test]
fn metadata_and_decimals_are_correct() {
    let contract = setup_minted();

    let contract_metadata = contract.mt_metadata_contract();
    assert_eq!(contract_metadata.spec, "mt-1.0.0");
    assert_eq!(contract_metadata.name, "Ironblock Items");

    let iron = contract.mt_metadata("iron_ore".to_string()).unwrap();
    assert_eq!(iron.token_id, "iron_ore");
    assert_eq!(iron.name, "Iron Ore");
    assert_eq!(iron.symbol, "IORE");
    assert!(iron.description.contains("ore"));
    assert!(iron.icon.starts_with("data:image/svg+xml;base64,"));
    assert_eq!(iron.decimals, 0);
    assert_eq!(iron.supply, U128(100_000));

    let base = contract
        .mt_metadata_base_by_token_id(vec!["grain".to_string()])
        .pop()
        .unwrap();
    assert_eq!(base.name, "Grain");
    assert_eq!(base.id, "grain");
    assert_eq!(base.symbol.as_deref(), Some("GRN"));
    assert_eq!(base.decimals, Some(U64(0)));
    assert!(base.icon.as_deref().unwrap().starts_with("data:image/svg+xml;base64,"));

    let instance = contract
        .mt_metadata_token_by_token_id(vec!["grain".to_string()])
        .pop()
        .unwrap();
    assert_eq!(instance.title.as_deref(), Some("Grain"));
    assert!(instance.description.unwrap().contains("grain"));

    let all = contract.mt_metadata_token_all(vec!["axe".to_string()]);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].base.id, "axe");
    assert_eq!(all[0].token.title.as_deref(), Some("Axe"));

    let json = serde_json::to_value(
        contract.mt_metadata_base_by_token_id(vec!["flour".to_string()]),
    )
    .unwrap();
    assert_eq!(json[0]["decimals"], "0");

    let item_json = serde_json::to_value(contract.mt_metadata("flour".to_string())).unwrap();
    assert_eq!(item_json["decimals"], 0);
    assert_eq!(item_json["supply"], "25000");

    assert!(contract.mt_metadata("mithril".to_string()).is_none());
    assert_eq!(
        contract.mt_batch_metadata(vec!["axe".to_string(), "mithril".to_string()]),
        vec![contract.mt_metadata("axe".to_string()), None]
    );
}

#[test]
fn transfer_to_implicit_account_works_without_registration() {
    let mut contract = setup_minted();
    let implicit = implicit_account();

    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        implicit.clone(),
        "grain".to_string(),
        U128(42),
        None,
        Some("implicit receiver".to_string()),
    );

    assert_eq!(
        contract.mt_balance_of(implicit.clone(), "grain".to_string()),
        U128(42)
    );
    let owned = contract.mt_tokens_for_owner(implicit.clone(), None, None);
    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0].token_id, "grain");
    assert_eq!(owned[0].owner_id, Some(implicit));
}

#[test]
fn enumeration_and_pagination_work() {
    let mut contract = setup_minted();

    let all = contract.mt_tokens(None, None);
    assert_eq!(all.len(), 11);
    assert_eq!(all[0].token_id, "iron_ore");
    assert!(all.iter().all(|token| token.owner_id.is_none()));

    let page = contract.mt_tokens(Some(U128(9)), Some(5));
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].token_id, "hoe");
    assert_eq!(page[1].token_id, "axe");

    assert!(contract.mt_tokens(Some(U128(100)), None).is_empty());
    assert_eq!(
        contract.mt_tokens_base_metadata_all(Some(U128(8)), None).len(),
        3
    );

    set_env(&treasury_id(), 1, 100);
    contract.mt_transfer(
        alice(),
        "cloth".to_string(),
        U128(10),
        None,
        None,
    );
    let alice_tokens = contract.mt_tokens_for_owner(alice(), None, None);
    assert_eq!(alice_tokens.len(), 1);
    assert_eq!(alice_tokens[0].token_id, "cloth");
    assert!(contract
        .mt_tokens_for_owner(alice(), Some(U128(1)), None)
        .is_empty());
}

#[test]
fn transfer_call_can_refund_unused_tokens() {
    let mut contract = setup_minted();

    set_env(&treasury_id(), 1, 100);
    let promise = contract.mt_transfer_call(
        alice(),
        "iron_ore".to_string(),
        U128(1_000),
        None,
        Some("market purchase".to_string()),
        "{\"quantity\":600}".to_string(),
    );
    // Promise creation is mocked in unit tests; the balance move is immediate.
    let _ = promise;
    assert_eq!(
        contract
            .mt_balance_of(alice(), "iron_ore".to_string())
            .0,
        1_000
    );

    let spent = contract.resolve_transfer(
        treasury_id(),
        alice(),
        vec!["iron_ore".to_string()],
        vec![U128(1_000)],
        Ok(vec![U128(400)]),
    );
    assert_eq!(spent, vec![U128(600)]);
    assert_eq!(
        contract
            .mt_balance_of(alice(), "iron_ore".to_string())
            .0,
        600
    );
    assert_eq!(
        contract
            .mt_balance_of(treasury_id(), "iron_ore".to_string())
            .0,
        99_400
    );
}

#[test]
#[allow(deprecated)]
fn transfer_call_callback_reads_receiver_result() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    let _ = contract.mt_transfer_call(
        alice(),
        "iron_ore".to_string(),
        U128(1_000),
        None,
        None,
        "{}".to_string(),
    );

    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(contract_id())
        .signer_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .attached_deposit(NearToken::from_yoctonear(0))
        .prepaid_gas(Gas::from_tgas(100));
    let result = serde_json::to_vec(&vec![U128(400)]).unwrap();
    testing_env_with_promise_results(builder.build(), PromiseResult::Successful(result));

    let spent = contract.mt_resolve_transfer(
        treasury_id(),
        alice(),
        vec!["iron_ore".to_string()],
        vec![U128(1_000)],
    );
    assert_eq!(spent, vec![U128(600)]);
    assert_eq!(
        contract
            .mt_balance_of(alice(), "iron_ore".to_string())
            .0,
        600
    );
}

#[test]
#[allow(deprecated)]
fn malformed_transfer_call_result_refunds_everything() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    let _ = contract.mt_transfer_call(
        bob(),
        "grain".to_string(),
        U128(250),
        None,
        None,
        "{}".to_string(),
    );

    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(contract_id())
        .signer_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .prepaid_gas(Gas::from_tgas(100));
    testing_env_with_promise_results(
        builder.build(),
        PromiseResult::Successful(b"not-json".to_vec()),
    );

    let spent = contract.mt_resolve_transfer(
        treasury_id(),
        bob(),
        vec!["grain".to_string()],
        vec![U128(250)],
    );
    assert_eq!(spent, vec![U128(0)]);
    assert_eq!(contract.mt_balance_of(bob(), "grain".to_string()).0, 0);
    assert_eq!(
        contract
            .mt_balance_of(treasury_id(), "grain".to_string())
            .0,
        100_000
    );
}

#[test]
fn transfer_call_failed_receiver_refunds_everything() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    let _ = contract.mt_transfer_call(
        bob(),
        "grain".to_string(),
        U128(250),
        None,
        None,
        "{}".to_string(),
    );

    let spent = contract.resolve_transfer(
        treasury_id(),
        bob(),
        vec!["grain".to_string()],
        vec![U128(250)],
        Err(PromiseError::Failed),
    );
    assert_eq!(spent, vec![U128(0)]);
    assert_eq!(contract.mt_balance_of(bob(), "grain".to_string()).0, 0);
    assert_eq!(
        contract
            .mt_balance_of(treasury_id(), "grain".to_string())
            .0,
        100_000
    );
}

#[test]
#[should_panic(expected = "approvals must have the same length")]
fn batch_approvals_length_must_match() {
    let mut contract = setup_minted();
    set_env(&treasury_id(), 1, 100);
    contract.mt_batch_transfer(
        alice(),
        vec!["iron_ore".to_string()],
        vec![U128(1)],
        Some(vec![]),
        None,
    );
}
