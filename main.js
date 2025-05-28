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

// === CONFIGURABLE SECTION ===
const rpcEndpoint = "https://empe-testnet-rpc.polkachu.com";
const prefix = "empe";
const denom = "uempe";
const feeAmount = "500";

// === RANGE JUMLAH TRANSAKSI (BISA DISESUAIKAN MASING-MASING) ===
function randSendCount() {
  return Math.floor(Math.random() * 4) + 3; // 3-6
}
function randDelegateCount() {
  return Math.floor(Math.random() * 4) + 3; // 3-6
}
function randUndelegateCount() {
  return Math.floor(Math.random() * 2) + 1; // 1-2
}
function randRedelegateCount() {
  return Math.floor(Math.random() * 2) + 1; // 1-2
}

// RANGE NOMINAL (DALAM uempe)
const amountsend = { min: 100, max: 1000 };              // 0.0001~0.001 EMPE
const amountdelegate = { min: 3000, max: 5000 };         // 0.003~0.005 EMPE
const amountundelegate = { min: 100, max: 300 };         // 0.0001~0.0003 EMPE
const amountredelegate = { min: 100, max: 300 };         // 0.0001~0.0003 EMPE

// Gas limits
const gasSend = "80000";
const gasDelegate = "160000";
const gasWithdraw = "130000";
const gasUndelegate = "240000";
const gasRedelegate = "350000";

// Helper: validator logic
function getValidators() {
  return fs.readFileSync("val.txt", "utf-8")
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
// Shuffle array in-place
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Generate a random address (from a new mnemonic)
async function getRandomAddress(prefix = "empe") {
  const wallet = await DirectSecp256k1HdWallet.generate(12, { prefix });
  const [account] = await wallet.getAccounts();
  return account.address;
}

// Check for in-progress redelegation between srcVal and dstVal
async function isRedelegationInProgress(queryClient, delegator, srcVal, dstVal) {
  try {
    const redelegations = await queryClient.staking.redelegations(delegator, srcVal, dstVal);
    return (
      redelegations &&
      redelegations.redelegationResponses &&
      redelegations.redelegationResponses.length > 0
    );
  } catch {
    return false; // Jika error, anggap tidak ada yg pending daripada stuck
  }
}

async function processWallets() {
  const mnemonics = fs.readFileSync("wallet.txt", "utf-8").split("\n").filter(Boolean);
  const validators = getValidators();

  for (const mnemonic of mnemonics) {
    try {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix });
      const [account] = await wallet.getAccounts();
      console.log(`\n=== Processing wallet: ${account.address} ===`);

      // JUMLAH TRANSAKSI MASING-MASING AKSI DENGAN RANDOM SENDIRI-SEDIRI
      const sendCount = randSendCount();
      const delegateCount = randDelegateCount();
      const undelegateCount = randUndelegateCount();
      const redelegateCount = randRedelegateCount();
      console.log(`Random send: ${sendCount}, delegate: ${delegateCount}, undelegate: ${undelegateCount}, redelegate: ${redelegateCount}`);

      const tmClient = await Tendermint34Client.connect(rpcEndpoint);
      const queryClient = QueryClient.withExtensions(
        tmClient, setupStakingExtension, setupDistributionExtension
      );
      const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);

      // STEP 1: Randomize order of [send, claim, delegate]
      const actions1 = ["send", "claim", "delegate"];
      shuffle(actions1);

      // For claim reward, build function
      async function claimReward() {
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
      }

      // For delegate
      const delegatedValidators = [];
      async function doDelegate() {
        for (let i = 0; i < delegateCount; i++) {
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
      }

      // For send to random wallet (random mnemonic, not from wallet.txt)
      async function doSend() {
        for (let i = 0; i < sendCount; i++) {
          const destWallet = await getRandomAddress(prefix);
          const sendAmount = randomAmount(amountsend.min, amountsend.max);
          try {
            const sendResult = await client.sendTokens(
              account.address,
              destWallet,
              coins(sendAmount, denom),
              { amount: coins(feeAmount, denom), gas: gasSend },
              ""
            );
            if (sendResult.code === 0) {
              console.log(`Send Success (${sendAmount} uempe to ${destWallet})`);
            } else {
              console.log(`Send Failed (${destWallet})`);
            }
          } catch {
            console.log(`Send Failed (${destWallet})`);
          }
        }
      }

      // Jalankan acak urutan send, claim, delegate
      for (const act of actions1) {
        if (act === "send") await doSend();
        if (act === "claim") await claimReward();
        if (act === "delegate") await doDelegate();
      }

      // STEP 2: Randomize order of [undelegate, redelegate]
      const actions2 = ["undelegate", "redelegate"];
      shuffle(actions2);

      async function doUndelegate() {
        for (let i = 0; i < Math.min(undelegateCount, delegatedValidators.length); i++) {
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
      }

      async function doRedelegate() {
        for (let i = 0; i < Math.min(redelegateCount, delegatedValidators.length); i++) {
          const srcVal = delegatedValidators[i];
          const redelegateAmount = randomAmount(amountredelegate.min, amountredelegate.max);
          let dstVal;
          try {
            dstVal = getRandomValidator(validators, [srcVal, ...delegatedValidators]);
          } catch {
            console.log(`Redelegate Failed (no available dst validator for ${srcVal})`);
            continue;
          }
          const inProgress = await isRedelegationInProgress(queryClient, account.address, srcVal, dstVal);
          if (inProgress) {
            console.log(`Skip redelegate: redelegation from ${srcVal} to ${dstVal} is still in progress`);
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
      }

      // Jalankan acak urutan undelegate, redelegate
      for (const act of actions2) {
        if (act === "undelegate") await doUndelegate();
        if (act === "redelegate") await doRedelegate();
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
