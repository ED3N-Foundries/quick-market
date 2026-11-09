use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken};

#[near(serializers = [json])]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(contract_state)]
#[derive(near_sdk::PanicOnDefault)]
pub struct Contract {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
    minter: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(minter: AccountId) -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            total_supply: 0,
            minter,
        }
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".into(),
            name: "quick-market".into(),
            symbol: "QM".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        emit(
            "ft_transfer",
            serde_json::json!({
                "old_owner_id": sender,
                "new_owner_id": receiver_id,
                "amount": amount.0.to_string(),
            }),
        );
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let sender = env::predecessor_account_id();
        require!(sender == self.minter, "Not minter");
        let next = self.balances.get(&account_id).copied().unwrap_or(0) + amount.0;
        self.balances.insert(account_id.clone(), next);
        self.total_supply += amount.0;
        emit(
            "ft_mint",
            serde_json::json!({
                "owner_id": account_id,
                "amount": amount.0.to_string(),
            }),
        );
    }

    /// Removes QM from the minter balance. Agent bleed uses this because NEAR has no dead address.
    pub fn burn(&mut self, amount: U128) {
        let sender = env::predecessor_account_id();
        require!(sender == self.minter, "Not minter");
        let balance = self.balances.get(&sender).copied().unwrap_or(0);
        require!(balance >= amount.0, "Insufficient balance");
        self.balances.insert(sender.clone(), balance - amount.0);
        self.total_supply -= amount.0;
        emit(
            "ft_burn",
            serde_json::json!({
                "owner_id": sender,
                "amount": amount.0.to_string(),
            }),
        );
    }

    /// Wallets ask before a transfer. This token does not charge storage, so every account is ready.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(StorageBalance {
            total: U128(0),
            available: U128(0),
        })
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = (account_id, registration_only);
        let attached = env::attached_deposit();
        if attached.as_yoctonear() > 0 {
            near_sdk::Promise::new(env::predecessor_account_id()).transfer(attached);
        }
        StorageBalance {
            total: U128(0),
            available: U128(0),
        }
    }
}

impl Contract {
    fn move_tokens(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        let balance = self.balances.get(sender).copied().unwrap_or(0);
        require!(balance >= amount, "Insufficient balance");
        self.balances.insert(sender.clone(), balance - amount);
        let next = self.balances.get(receiver).copied().unwrap_or(0) + amount;
        self.balances.insert(receiver.clone(), next);
    }
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({
            "standard": "nep141",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}
