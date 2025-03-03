import {
  Connection,
  Transaction,
  PublicKey,
  VersionedTransaction,
  SimulateTransactionConfig
} from '@solana/web3.js';
import {
  AccountLayout,
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import axios from 'axios';
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fetchDigitalAsset } from "@metaplex-foundation/mpl-token-metadata";
import { publicKey } from "@metaplex-foundation/umi";

// Create a UMI instance
const umi = createUmi("https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3");

export interface TokenAsset {
  mint: string;
  balanceChange: number;
  amount: number;
  logouri: string;
  decimals: number;
  symbol?: string; 
  name?: string;
  isNft?: boolean; // New field to indicate if this is an NFT
}

export interface WalletBalanceChange {
  wallet: string;
  buying: TokenAsset[];
  selling: TokenAsset[]; 
}

// Cache for token info to reduce API calls
const tokenInfoCache = new Map<string, { logouri: string, decimals: number, symbol?: string, name?: string }>();

// Cache for NFT info to reduce API calls
const nftInfoCache = new Map<string, { isNft: boolean, name?: string, symbol?: string, image?: string }>();

// Function to check if a token is an NFT and fetch its metadata
async function checkAndFetchNftInfo(mintAddress: string): Promise<{ isNft: boolean, name?: string, symbol?: string, image?: string }> {
// Check cache first
if (nftInfoCache.has(mintAddress)) {
  return nftInfoCache.get(mintAddress)!;
}

try {
  // Fetch digital asset data using Metaplex SDK
  const asset = await fetchDigitalAsset(umi, publicKey(mintAddress));
  
  let imageUrl = '';
  
  // Try to fetch metadata JSON to get the image URL
  if (asset.metadata.uri) {
    try {
      const response = await axios.get(asset.metadata.uri);
      imageUrl = response.data.image || '';
    } catch (error) {
      // Ignore error, we'll just have an empty image URL
    }
  }
  
  // If we successfully fetch metadata, it's an NFT
  const nftInfo = {
    isNft: true,
    name: asset.metadata.name,
    symbol: asset.metadata.symbol,
    image: imageUrl
  };
  
  // Cache the result
  nftInfoCache.set(mintAddress, nftInfo);
  
  return nftInfo;
} catch (error) {
  // If there's an error fetching metadata, it's likely not an NFT
  const notNftInfo = { isNft: false };
  nftInfoCache.set(mintAddress, notNftInfo);
  return notNftInfo;
}
}

// Function to fetch token information from Jupiter API with caching
export async function fetchTokenInfo(mintAddress: string): Promise<{ logouri: string, decimals: number, symbol?: string, name?: string }> {
  // Special case for native SOL
  if (mintAddress === 'So11111111111111111111111111111111111111112') {
    return {
      logouri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      decimals: 9,
      symbol: 'SOL',
      name: 'Wrapped SOL'
    };
  }
  
  // Check cache first
  if (tokenInfoCache.has(mintAddress)) {
    return tokenInfoCache.get(mintAddress)!;
  }
  
  try {
    const response = await axios.get(`https://tokens.jup.ag/token/${mintAddress}`);
    const tokenInfo = {
      logouri: response.data.logoURI || '',
      decimals: response.data.decimals || 0,
      symbol: response.data.symbol || '',
      name: response.data.name || ''
    };
    
    // Cache the result
    tokenInfoCache.set(mintAddress, tokenInfo);
    
    return tokenInfo;
  } catch (error) {
    // Return default values and do not cache errors
    return {
      logouri: '',
      decimals: 0,
      symbol: mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4)
    };
  }
}

export async function simulateVersionedTransactionWithBalanceChanges(
serializedTransaction: string,
connection: Connection,
) {
// Convert Base64 to VersionedTransaction
const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);
const targetWallet = versionedTransaction.message.staticAccountKeys[0].toBase58();

// Get the accounts involved in the transaction from the message
const message = versionedTransaction.message;
const staticAccountKeys = message.staticAccountKeys;

// Get accounts lookups if they exist
let allAccountKeys = [...staticAccountKeys];

// Get unique accounts as strings for the RPC call
const uniqueAccountsStr = [...new Set(allAccountKeys.map(acc => acc.toBase58()))];

// Step 1: Get pre-simulation account info and balances
const preBalances = new Map();
const solPreBalances = new Map();

for (const accountAddress of uniqueAccountsStr) {
  const pubkey = new PublicKey(accountAddress);
  try {
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    // Store the SOL balance
    solPreBalances.set(accountAddress, accountInfo?.lamports || 0);
    
    // Check if this is a token account
    if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length === ACCOUNT_SIZE) {
      const decoded = AccountLayout.decode(accountInfo.data);
      const mint = decoded.mint.toString();
      const amount = Number(decoded.amount);
      const owner = decoded.owner.toString(); 
      
      preBalances.set(accountAddress, { mint, amount, owner });
    }
  } catch (error) {
    // Error handling without logging
  }
}

// Step 2: Simulate the transaction with accounts parameter
const simulateConfig: SimulateTransactionConfig = {
  commitment: 'confirmed',
  replaceRecentBlockhash: true,
  sigVerify: false,
  accounts: {
    encoding: 'base64',
    addresses: uniqueAccountsStr
  },
  innerInstructions: true
};

const simulationResult = await connection.simulateTransaction(
  versionedTransaction,
  simulateConfig
);
//console.log('Simulation result:', simulationResult);

// Step 3: Extract post-simulation account info from the response
const postSimAccounts = simulationResult.value.accounts;

// Check if accounts array is available
if (!postSimAccounts) {
  throw new Error("Simulation did not return account data. This may be due to an error in the transaction.");
}

// Process the post-simulation balances
const postBalances = new Map();
const solPostBalances = new Map();

uniqueAccountsStr.forEach((accountAddress, index) => {
  const postAccount = postSimAccounts[index];
  
  // Store the SOL balance
  solPostBalances.set(accountAddress, postAccount?.lamports || 0);
  
  // If this is a token account, decode the data
  if (postAccount && 
      postAccount.owner === TOKEN_PROGRAM_ID.toBase58() && 
      postAccount.data[0]) {
    
    try {
      const buffer = Buffer.from(postAccount.data[0], 'base64');
      const decoded = AccountLayout.decode(buffer);
      
      const mint = decoded.mint.toString();
      const amount = Number(decoded.amount);
      const owner = decoded.owner.toString();
      
      postBalances.set(accountAddress, { mint, amount, owner });
    } catch (error) {
      // Error handling without logging
    }
  }
});

// Calculate SOL balance change for target wallet
let targetWalletSolChange = 0;

// Process token accounts for the target wallet
const buying: TokenAsset[] = [];
const selling: TokenAsset[] = [];

// First, track direct SOL changes for the target wallet if it's in the accounts list
if (solPreBalances.has(targetWallet) && solPostBalances.has(targetWallet)) {
  const preSolBalance = solPreBalances.get(targetWallet) || 0;
  const postSolBalance = solPostBalances.get(targetWallet) || 0;
  targetWalletSolChange = postSolBalance - preSolBalance;
}

// Calculate and collect token balance changes from pre-existing accounts
for (const [address, preInfo] of preBalances.entries()) {
  const postInfo = postBalances.get(address);
  
  // Only process token accounts owned by our target wallet
  if (preInfo.owner === targetWallet && postInfo) {
    const balanceChange = postInfo.amount - preInfo.amount;
    
    // Only include accounts with balance changes
    if (balanceChange !== 0) {
      // Fetch token info from Jupiter API
      const tokenInfo = await fetchTokenInfo(preInfo.mint);
      
      // Check if this might be an NFT (0 decimals and balance change of exactly 1 or -1)
      const mightBeNft = tokenInfo.decimals === 0 && Math.abs(balanceChange) === 1;
      let isNft = false;
      let nftName: string | undefined;
      let nftSymbol: string | undefined;
      let nftImage: string | undefined;
      
      if (mightBeNft) {
        // Try to fetch NFT metadata
        const nftInfo = await checkAndFetchNftInfo(preInfo.mint);
        isNft = nftInfo.isNft;
        nftName = nftInfo.name;
        nftSymbol = nftInfo.symbol;
        nftImage = nftInfo.image;
      }
      
      const tokenAsset: TokenAsset = {
        mint: preInfo.mint,
        balanceChange: balanceChange,
        logouri: isNft ? (nftImage || tokenInfo.logouri) : tokenInfo.logouri,
        decimals: tokenInfo.decimals,
        amount: isNft ? balanceChange : balanceChange / (10 ** tokenInfo.decimals),
        symbol: isNft ? (nftSymbol || tokenInfo.symbol) : tokenInfo.symbol,
        name: isNft ? (nftName || tokenInfo.name) : tokenInfo.name,
        isNft
      };
      
      // Add to buying or selling based on the balance change direction
      if (balanceChange > 0) {
        buying.push(tokenAsset);
      } else if (balanceChange < 0) {
        selling.push({
          ...tokenAsset,
          balanceChange: balanceChange // Keep negative for selling
        });
      }
    }
  }
}

// Also check for newly created token accounts
for (const [address, postInfo] of postBalances.entries()) {
  // Skip accounts we've already processed
  if (preBalances.has(address)) continue;
  
  // Check if this is a token account owned by our target wallet
  if (postInfo.owner === targetWallet) {
    const balanceChange = postInfo.amount; 
    
    // Only include accounts with balance changes
    if (balanceChange > 0) {
      // Fetch token info from Jupiter API
      const tokenInfo = await fetchTokenInfo(postInfo.mint);
      
      // Check if this might be an NFT (0 decimals and balance change of exactly 1)
      const mightBeNft = tokenInfo.decimals === 0 && balanceChange === 1;
      let isNft = false;
      let nftName: string | undefined;
      let nftSymbol: string | undefined;
      let nftImage: string | undefined;
      
      if (mightBeNft) {
        // Try to fetch NFT metadata
        const nftInfo = await checkAndFetchNftInfo(postInfo.mint);
        isNft = nftInfo.isNft;
        nftName = nftInfo.name;
        nftSymbol = nftInfo.symbol;
        nftImage = nftInfo.image;
      }
      
      const tokenAsset: TokenAsset = {
        mint: postInfo.mint,
        balanceChange: balanceChange,
        logouri: isNft ? (nftImage || tokenInfo.logouri) : tokenInfo.logouri,
        decimals: tokenInfo.decimals,
        amount: isNft ? balanceChange : balanceChange / (10 ** tokenInfo.decimals),
        symbol: isNft ? (nftSymbol || tokenInfo.symbol) : tokenInfo.symbol,
        name: isNft ? (nftName || tokenInfo.name) : tokenInfo.name,
        isNft
      };
      
      // New accounts with positive balance must be buying
      buying.push(tokenAsset);
    }
  }
}

// Handle native SOL token (wrapped SOL) specially
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Check if there are any wrapped SOL changes and combine them with direct SOL changes
const wrappedSolBuyIndex = buying.findIndex(asset => asset.mint === SOL_MINT);
const wrappedSolSellIndex = selling.findIndex(asset => asset.mint === SOL_MINT);

let wrappedSolChange = 0;

// Extract wrapped SOL changes and remove them from the lists since we'll handle them separately
if (wrappedSolBuyIndex !== -1) {
  wrappedSolChange += buying[wrappedSolBuyIndex].balanceChange;
  buying.splice(wrappedSolBuyIndex, 1);
}

if (wrappedSolSellIndex !== -1) {
  wrappedSolChange += selling[wrappedSolSellIndex].balanceChange;
  selling.splice(wrappedSolSellIndex, 1);
}

// Calculate the total SOL change (direct SOL + wrapped SOL)
const totalSolChange = targetWalletSolChange + wrappedSolChange;

// Create token asset for SOL with the total change
if (totalSolChange !== 0) {
  // Get token info for SOL
  const solTokenInfo = await fetchTokenInfo(SOL_MINT);
  
  const solAsset: TokenAsset = {
    mint: SOL_MINT,
    balanceChange: totalSolChange,
    logouri: solTokenInfo.logouri,
    decimals: solTokenInfo.decimals,
    amount: totalSolChange/(10**solTokenInfo.decimals),
    symbol: solTokenInfo.symbol,
    name: solTokenInfo.name,
    isNft: false
  };
  
  // Add SOL to the appropriate list based on whether it's being bought or sold
  if (totalSolChange > 0) {
    buying.push(solAsset);
  } else if (totalSolChange < 0) {
    selling.push({
      ...solAsset,
      balanceChange: totalSolChange 
    });
  }
}

// Create the wallet balance change output
const walletBalanceChange: WalletBalanceChange = {
  wallet: targetWallet,
  buying,
  selling
};

return {
  walletBalanceChange,
  success: simulationResult.value.err === null
};
}