// Place under MetaDAO parent project as "Futarchy DAO Treasuries"
const { getConnection, sumTokens2 } = require('../helper/solana')
const { PublicKey, Keypair } = require('@solana/web3.js')
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor')
const { FutarchyClient } = require("@metadaoproject/futarchy/v0.6")
const { CpAmm } = require("@meteora-ag/cp-amm-sdk")
const BN = require('bn.js')

// Define throttle
const SLEEP_MS = 5000
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Targeted tokens
const TOKEN_PROGRAM_IDS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // SPL Token
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022
]

// DAMM v2 program - position PDAs derived from
const DAMM_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")

// Retry helper
async function fetchWithRetry(fetchFn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchFn()
    } catch (e) {
      if (e.message.includes('429') && i < maxRetries - 1) {
        const backoff = Math.pow(2, i) * 1000
        console.log(`Rate limited, waiting ${backoff}ms...`)
        await sleep(backoff)
        continue
      }
      throw e
    }
  }
}

// FutarchyService (https://github.com/metaDAOproject/futarchy-coingecko-api/blob/e22678298032647c4e9aa6050ac120bc3b03ebe4/src/services/futarchyService.ts)
class FutarchyService {
  constructor(connection) {
    this.connection = connection

    let wallet
    try { wallet = Wallet.local() }
    catch (_) { wallet = new Wallet(Keypair.generate()) }

    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    })

    this.client = FutarchyClient.createClient({ provider })
  }

  async getAllDaos() {
    const rawDaos = await this.client.autocrat.account.dao.all()

    const daos = rawDaos
      .filter(d => d.account.squadsMultisigVault)
      .map(d => ({
        daoAddress: d.publicKey.toString(),
        treasuryVaultAddress: d.account.squadsMultisigVault.toString(),
      }))

    return daos
  }
}

// Derive PDA - NFT Mint <> Position PDA
function derivePositionPdaFromMint(mint) {
  const mintKey = new PublicKey(mint)

  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),   // DAMM v2 PDA seed
      mintKey.toBuffer(),        // NFT mint pubkey
    ],
    DAMM_PROGRAM_ID
  )

  return pda
}

// METEORA position decoding
async function getMeteoraPositionBalances(connection, positionPda) {
  try {
    const cpAmm = new CpAmm(connection)

    const positionState = await fetchWithRetry(() => 
      cpAmm.fetchPositionState(positionPda)
    )

    const poolAddress = positionState.pool
    const poolState = await fetchWithRetry(() => 
      cpAmm.fetchPoolState(poolAddress)
    )

    const liquidity = new BN(positionState.unlockedLiquidity, 16)

    const sqrtPrice = new BN(poolState.sqrtPrice, 16)
    const sqrtMinPrice = new BN(poolState.sqrtMinPrice, 16)
    const sqrtMaxPrice = new BN(poolState.sqrtMaxPrice, 16)

    const quote = await cpAmm.getWithdrawQuote({
      liquidityDelta: liquidity,
      sqrtPrice,
      minSqrtPrice: sqrtMinPrice,
      maxSqrtPrice: sqrtMaxPrice,
    })

    return {
      tokenAMint: poolState.tokenAMint.toString(),
      tokenBMint: poolState.tokenBMint.toString(),
      tokenAAmount: quote.outAmountA.toString(),
      tokenBAmount: quote.outAmountB.toString(),
    }

  } catch (e) {
    console.error("Decode error:", positionPda.toString(), e.message)
    return null
  }
}


// Combined TVL
async function tvl() {
  const connection = getConnection()

  // Futarchy DAO multisig vaults
  const service = new FutarchyService(connection)
  console.log("Fetching Futarchy DAOs...")

  const daos = await service.getAllDaos()
  const vaults = daos.map(d => d.treasuryVaultAddress)

  console.log("Found", vaults.length, "Futarchy vaults")

  // Add MetaDAO treasury
  vaults.push("BxgkvRwqzYFWuDbRjfTYfgTtb41NaFw1aQ3129F79eBT")

  const futarchyTokenAccounts = []
  const nftMints = new Set()
  const tokenAccountResults = []
  
  for (const vault of vaults) {
    console.log("Processing vault:", vault)
    const accounts = []
    
    for (const PROGRAM of TOKEN_PROGRAM_IDS) {
      try {
        await sleep(SLEEP_MS)
        const resp = await fetchWithRetry(() =>
          connection.getParsedTokenAccountsByOwner(
            new PublicKey(vault),
            { programId: PROGRAM },
          )
        )
        accounts.push(...resp.value)
      } catch (e) {
        console.log("Vault fetch error:", vault, e.message)
      }
    }
    
    tokenAccountResults.push(accounts)
  }

  // Process results
  tokenAccountResults.flat().forEach(acc => {
    futarchyTokenAccounts.push(acc.pubkey.toString())
    const info = acc.account.data.parsed.info
    if (info.tokenAmount.amount === "1") {
      nftMints.add(info.mint)
    }
  })

  console.log("Total Futarchy token accounts:", futarchyTokenAccounts.length)
  console.log("Discovered Meteora NFT mints:", nftMints.size)

  // Derive position PDAs
  const positionPdas = [...nftMints].map(mint => derivePositionPdaFromMint(mint))

  console.log("Derived position PDAs:", positionPdas.length)

  // Process Meteora positions
  const meteoraBalances = {}

  for (const pda of positionPdas) {
    await sleep(SLEEP_MS)
    const decoded = await getMeteoraPositionBalances(connection, pda)
    if (!decoded) continue

    meteoraBalances[decoded.tokenAMint] =
      (meteoraBalances[decoded.tokenAMint] || 0n) + BigInt(decoded.tokenAAmount)
    meteoraBalances[decoded.tokenBMint] =
      (meteoraBalances[decoded.tokenBMint] || 0n) + BigInt(decoded.tokenBAmount)
  }

  const formatted = {}
  for (const [mint, amount] of Object.entries(meteoraBalances)) {
    formatted[`solana:${mint}`] = amount.toString()
  }

  console.log("Meteora tokens discovered:", Object.keys(formatted).length)

  return sumTokens2({
    chain: 'solana',
    tokenAccounts: futarchyTokenAccounts,
    balances: formatted,
  })
}

module.exports = {
  timetravel: false,
  methodology:
    "Sum of Futarchy DAO Squads multisig vault SPL token balances and value of Futarchy DAO owned Meteora DAMM v2 LP positions.",
  solana: { tvl },
}
