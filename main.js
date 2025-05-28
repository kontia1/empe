const fs = require("fs");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const {
  SigningStargateClient,
  QueryClient,
  setupStakingExtension,
  setupDistributionExtension,
  coins,
} = require("@cosmjs/stargate");
const { Tendermint34Client } = require("@cosmjs/tendermint-rpc");

const rpcEndpoint = "https://empe-testnet-rpc.polkachu.com";
const prefix = "empe";
const denom = "uempe";
const feeAmount = "500";

// === JUMLAH TRANSAKSI YANG AKAN DILAKUKAN ===
const delegate = 2;   // Jumlah delegate per wallet
const undelegate = 2; // Jumlah undelegate per wallet
const redelegate = 2; // Jumlah redelegate per wallet

// === RANGE NOMINAL (DALAM uempe) BISA DIATUR DI SINI ===
const amountdelegate = { min: 3000, max: 5000 };     // 0.003 - 0.005 EMPE
const amountundelegate = { min: 100, max: 300 };     // 0.0001 - 0.0003 EMPE
const amountredelegate = { min: 100, max: 300 };     // 0.0001 - 0.0003 EMPE

// Gas limits
const gasDelegate = "160000";
const gasWithdraw = "130000";
const gasUndelegate = "240000";
const gasRedelegate = "350000";

function getValidators() {
  return fs.readFileSync("validator.txt", "utf-8")
    .split("\n").map(line => line.trim()).filter(Boolean);
}
function getRandomValidator(validators, except = []) {
  const filtered = validators.filter(val => !except.includes(val));
  if (!filtered.length) throw new Error("No valid destination validators found");
  return filtered[Math.floor(Math.random() * filtered.length)];
}
function randomAmount(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processWallets() {
  const mnemonics = fs.readFileSync("wallet.txt", "utf-8").split("\n").filter(Boolean);
  const validators = getValidators();

  for (const mnemonic of mnemonics) {
    try {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix });
      const [account] = await wallet.getAccounts();
      console.log(`\n=== Processing wallet: ${account.address} ===`);

      const tmClient = await Tendermint34Client.connect(rpcEndpoint);
      const queryClient = QueryClient.withExtensions(
        tmClient, setupStakingExtension, setupDistributionExtension
      );
      const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);

      // === 1. Delegate ke validator random ===
      const delegatedValidators = [];
      for (let i = 0; i < delegate; i++) {
        const dstValidator = getRandomValidator(validators, delegatedValidators);
        const delegateAmount = randomAmount(amountdelegate.min, amountdelegate.max);
        try {
          const delegateResult = await client.delegateTokens(
            account.address,
            dstValidator,
            { denom, amount: delegateAmount.toString() },
            { amount: coins(feeAmount, denom), gas: gasDelegate },
            ""
          );
          if (delegateResult.code === 0) {
            console.log(`Delegate Success (${delegateAmount} uempe to ${dstValidator})`);
            delegatedValidators.push(dstValidator);
          } else {
            console.log(`Delegate Failed (${dstValidator})`);
          }
        } catch {
          console.log(`Delegate Failed (${dstValidator})`);
        }
      }

      // === 2. Claim reward (semua validator sekaligus) ===
      const rewards = await queryClient.distribution.delegationTotalRewards(account.address);
      if (rewards && rewards.rewards && rewards.rewards.length > 0) {
        const msgs = rewards.rewards.map(reward => ({
          typeUrl: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
          value: {
            delegatorAddress: account.address,
            validatorAddress: reward.validatorAddress
          }
        }));
        const fee = {
          amount: coins(feeAmount, denom),
          gas: (130000 * msgs.length).toString()
        };
        const result = await client.signAndBroadcast(account.address, msgs, fee, "");
        if (result.code === 0) {
          console.log(`Claim reward Success (${msgs.length} validator)`);
        } else {
          console.log("Claim reward Failed");
        }
      } else {
        console.log("Claim reward Skipped (tidak ada rewards)");
      }

      // === 3. Undelegate dari validator yang didelegate barusan ===
      for (let i = 0; i < Math.min(undelegate, delegatedValidators.length); i++) {
        const valAddr = delegatedValidators[i];
        const undelegateAmount = randomAmount(amountundelegate.min, amountundelegate.max);
        try {
          const undelegateResult = await client.undelegateTokens(
            account.address,
            valAddr,
            { denom, amount: undelegateAmount.toString() },
            { amount: coins(feeAmount, denom), gas: gasUndelegate },
            ""
          );
          if (undelegateResult.code === 0) {
            console.log(`Undelegate Success (${undelegateAmount} from ${valAddr})`);
          } else {
            console.log(`Undelegate Failed (${valAddr})`);
          }
        } catch {
          console.log(`Undelegate Failed (${valAddr})`);
        }
      }

      // === 4. Redelegate dari validator yang didelegate barusan ke validator random lainnya ===
      for (let i = 0; i < Math.min(redelegate, delegatedValidators.length); i++) {
        const srcVal = delegatedValidators[i];
        const redelegateAmount = randomAmount(amountredelegate.min, amountredelegate.max);
        let dstVal;
        try {
          dstVal = getRandomValidator(validators, [srcVal, ...delegatedValidators]);
        } catch {
          console.log(`Redelegate Failed (no available dst validator for ${srcVal})`);
          continue;
        }
        try {
          const msg = {
            typeUrl: "/cosmos.staking.v1beta1.MsgBeginRedelegate",
            value: {
              delegatorAddress: account.address,
              validatorSrcAddress: srcVal,
              validatorDstAddress: dstVal,
              amount: { denom, amount: redelegateAmount.toString() }
            }
          };
          const fee = {
            amount: coins(feeAmount, denom),
            gas: gasRedelegate,
          };
          const redelegateResult = await client.signAndBroadcast(account.address, [msg], fee, "");
          if (redelegateResult.code === 0) {
            console.log(`Redelegate Success (${redelegateAmount} from ${srcVal} to ${dstVal})`);
          } else {
            console.log(`Redelegate Failed (${srcVal} to ${dstVal})`);
          }
        } catch {
          console.log(`Redelegate Failed (${srcVal} to ${dstVal})`);
        }
      }

    } catch (err) {
      console.error("Error with mnemonic:", err.message);
    }
  }
}

// Cycle every 24 hours
async function runForever() {
  while (true) {
    console.log(`\n=== Cycle started at ${new Date().toISOString()} ===`);
    await processWallets();
    console.log(`=== Cycle complete. Sleeping 24 hours... ===\n`);
    await new Promise(r => setTimeout(r, 24 * 60 * 60 * 1000));
  }
}

runForever().catch(console.error);
