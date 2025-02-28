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
export interface TokenAsset {
    mint: string;
    balanceChange: number;
    amount:number
    logouri: string;
    decimals: number;
    symbol?: string; 
    name?: string;    
  }
  
export interface WalletBalanceChange {
    wallet: string;
    buying: TokenAsset[];
    selling: TokenAsset[];
    solChange?: number; // Keeping for backward compatibility but will be set to 0
}
  
  // Cache for token info to reduce API calls
  const tokenInfoCache = new Map<string, { logouri: string, decimals: number, symbol?: string, name?: string }>();
  
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
      } catch (error : any) {
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
      
      // If this is a token account we've tracked pre-simulation, decode the data
      if (preBalances.has(accountAddress) && postAccount && 
          postAccount.owner === TOKEN_PROGRAM_ID.toBase58() && 
          postAccount.data[0]) {
        
        const preInfo = preBalances.get(accountAddress);
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
    
    // Calculate and collect token balance changes for the specific wallet only
    for (const [address, preInfo] of preBalances.entries()) {
      const postInfo = postBalances.get(address);
      
      // Only process token accounts owned by our target wallet
      if (preInfo.owner === targetWallet && postInfo) {
        const balanceChange = postInfo.amount - preInfo.amount;
        
        // Only include accounts with balance changes
        if (balanceChange !== 0) {
          // Fetch token info from Jupiter API
          const tokenInfo = await fetchTokenInfo(preInfo.mint);
          
          const tokenAsset: TokenAsset = {
            mint: preInfo.mint,
            balanceChange: balanceChange,
            logouri: tokenInfo.logouri,
            decimals: tokenInfo.decimals,
            amount:balanceChange/(10**tokenInfo.decimals),
            symbol: tokenInfo.symbol,
            name: tokenInfo.name
          };
          
          // Add to buying or selling based on the balance change direction
          if (balanceChange > 0) {
            buying.push(tokenAsset);
          } else {
            selling.push(tokenAsset);
          }
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
        amount:totalSolChange/(10**solTokenInfo.decimals),
        symbol: solTokenInfo.symbol,
        name: solTokenInfo.name
      };
      
      // Add SOL to the appropriate list based on whether it's being bought or sold
      if (totalSolChange > 0) {
        buying.push(solAsset);
      } else if (totalSolChange < 0) {
        selling.push({
          ...solAsset,
          balanceChange: Math.abs(totalSolChange) * -1 // Keep the negative sign for selling
        });
      }
    }
    
    // Create the wallet balance change output
    const walletBalanceChange: WalletBalanceChange = {
      wallet: targetWallet,
      buying,
      selling,
      solChange: 0 // Setting to 0 since we're now including SOL in the token lists
    };
    
    return {
      walletBalanceChange,
      success: simulationResult.value.err === null
    };
}