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

// Updated interface for the token asset output
interface TokenAsset {
  mint: string;
  balanceChange: number;
  logouri: string;
  decimals: number;
}

interface TransactionInfo {
  account: string; // This will hold the wallet public key (owner), not the token account
  assets: TokenAsset;
}

// Function to fetch token information from Jupiter API
async function fetchTokenInfo(mintAddress: string): Promise<{ logouri: string, decimals: number }> {
  try {
    const response = await axios.get(`https://tokens.jup.ag/token/${mintAddress}`);
    return {
      logouri: response.data.logoURI || '',
      decimals: response.data.decimals || 0
    };
  } catch (error) {
    console.log(`Error fetching token info for ${mintAddress}:`, error);
    return {
      logouri: '',
      decimals: 0
    };
  }
}

async function simulateTransactionWithBalanceChanges(
  serializedTransaction: string,
  connection: Connection
) {
  // Convert Base64 to Transaction
  const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
  const transaction = Transaction.from(transactionBuffer);
  
  // Get the accounts involved in the transaction
  const accounts = transaction.instructions.flatMap(ix => 
    ix.keys.map(key => key.pubkey)
  );
  const uniqueAccounts = [...new Set(accounts.map(acc => acc.toBase58()))];
  console.log(`Transaction involves ${uniqueAccounts.length} unique accounts`);
  
  // Get pre-simulation token balances 
  const preBalances = new Map();
  for (const accountAddress of uniqueAccounts) {
    const pubkey = new PublicKey(accountAddress);
    try {
      const accountInfo = await connection.getAccountInfo(pubkey);
      
      // Check if this is a token account
      if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length === ACCOUNT_SIZE) {
        const decoded = AccountLayout.decode(accountInfo.data);
        const mint = decoded.mint.toString();
        const amount = Number(decoded.amount);
        const owner = decoded.owner.toString(); 
        
        preBalances.set(accountAddress, { mint, amount, owner });
        console.log(`Pre-simulation: Token Account ${accountAddress} with ${amount} of token ${mint} owned by wallet ${owner}`);
      }
    } catch (error : any) {
      console.log(`Error fetching account ${accountAddress}: ${error.message}`);
    }
  }
  
  // Simulate the transaction
  console.log('Simulating transaction...');
  const simulationResult = await connection.simulateTransaction(transaction, undefined, true);
  
  if (!simulationResult.value.accounts) {
    console.log('Simulation did not return account information');
    return;
  }
  
  // Map accounts returned from simulation back to the transaction accounts
  // The accounts are returned in the same order they appear in the transaction
  const postBalances = new Map();
  
  // Extract token balances from simulation results
  for (let i = 0; i < simulationResult.value.accounts.length; i++) {
    const account = simulationResult.value.accounts[i];
    
    if (!account) continue;
    
    // Extract the account address from the transaction
    const accountPubkey = uniqueAccounts[i];
    
    // Check if it's a token account
    if (account.owner === TOKEN_PROGRAM_ID.toBase58()) {
      try {
        const data = Buffer.from(account.data[0], 'base64');
        
        // Verify it's actually a token account by checking size
        if (data.length === ACCOUNT_SIZE) {
          const decoded = AccountLayout.decode(data);
          const mint = decoded.mint.toString();
          const amount = Number(decoded.amount);
          const owner = decoded.owner.toString(); // Extract the wallet address
          
          postBalances.set(accountPubkey, { mint, amount, owner });
          console.log(`Post-simulation: Token Account ${accountPubkey} with ${amount} of token ${mint} owned by wallet ${owner}`);
        }
      } catch (error : any) {
        console.log(`Error decoding account data: ${error.message}`);
      }
    }
  }
  
  // Create the transaction info array with the requested format
  const transactionInfo: TransactionInfo[] = [];
  
  // Calculate and collect balance changes
  for (const [address, preInfo] of preBalances.entries()) {
    const postInfo = postBalances.get(address);
    
    if (postInfo) {
      const balanceChange = postInfo.amount - preInfo.amount;
      
      // Only include accounts with balance changes
      if (balanceChange !== 0) {
        // Fetch token info from Jupiter API
        const tokenInfo = await fetchTokenInfo(preInfo.mint);
        
        transactionInfo.push({
          account: preInfo.owner, // Using the wallet public key (owner) instead of token account address
          assets: {
            mint: preInfo.mint,
            balanceChange: balanceChange,
            logouri: tokenInfo.logouri,
            decimals: tokenInfo.decimals
          }
        });
      }
    }
  }
  
  // Output the transaction info array
  console.log('Transaction Info:');
  console.log(JSON.stringify(transactionInfo, null, 2));
  
  return {
    transactionInfo,
    preBalances: Object.fromEntries(preBalances),
    postBalances: Object.fromEntries(postBalances),
    success: simulationResult.value.err === null
  };
}

async function simulateVersionedTransactionWithBalanceChanges(
  serializedTransaction: string,
  connection: Connection
) {
  // Convert Base64 to VersionedTransaction
  const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
  const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);
  
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
        console.log(`Pre-simulation: Token Account ${accountAddress} with ${amount} of token ${mint} owned by wallet ${owner}`);
      }
    } catch (error : any) {
      console.log(`Error fetching account ${accountAddress}: ${error.message}`);
    }
  }
  
  // Step 2: Simulate the transaction with accounts parameter
  console.log('Simulating versioned transaction...');

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
        console.log(`Post-simulation: Token Account ${accountAddress} with ${amount} of token ${mint} owned by wallet ${owner}`);
      } catch (error) {
        console.error(`Error decoding post-simulation data for ${accountAddress}:`, error);
      }
    }
  });
  
  // Create the transaction info array with the requested format
  const transactionInfo: TransactionInfo[] = [];
  
  // Calculate and collect token balance changes
  for (const [address, preInfo] of preBalances.entries()) {
    const postInfo = postBalances.get(address);
    
    if (postInfo) {
      const balanceChange = postInfo.amount - preInfo.amount;
      
      // Only include accounts with balance changes
      if (balanceChange !== 0) {
        // Fetch token info from Jupiter API
        const tokenInfo = await fetchTokenInfo(preInfo.mint);
        
        transactionInfo.push({
          account: preInfo.owner, 
          assets: {
            mint: preInfo.mint,
            balanceChange: balanceChange,
            logouri: tokenInfo.logouri,
            decimals: tokenInfo.decimals
          }
        });
      }
    }
  }
  
  // Output the transaction info array
  console.log('Transaction Info:');
  console.log(JSON.stringify(transactionInfo, null, 2));
  
  // Step 4: Calculate detailed balance changes for return value
  const tokenBalanceChanges = {};
  for (const [address, preInfo] of preBalances.entries()) {
    const postInfo = postBalances.get(address);
    
    if (postInfo) {
      // Fetch token info from Jupiter API if there's a balance change
      const balanceChange = postInfo.amount - preInfo.amount;
      let tokenInfo = { logouri: '', decimals: 0 };
      
      if (balanceChange !== 0) {
        tokenInfo = await fetchTokenInfo(preInfo.mint);
      }
      
      //@ts-ignore
      tokenBalanceChanges[address] = {
        mint: preInfo.mint,
        preAmount: preInfo.amount,
        postAmount: postInfo.amount,
        change: postInfo.amount - preInfo.amount,
        owner: preInfo.owner,
        logouri: tokenInfo.logouri,
        decimals: tokenInfo.decimals
      };
    }
  }
  
  const solBalanceChanges = {};
  for (const [address, preBalance] of solPreBalances.entries()) {
    const postBalance = solPostBalances.get(address) || 0;
    //@ts-ignore
    solBalanceChanges[address] = {
      preBalance,
      postBalance,
      change: postBalance - preBalance
    };
  }
  
  return {
    transactionInfo,
    tokenBalanceChanges,
    solBalanceChanges,
    logs: simulationResult.value.logs || [],
    success: simulationResult.value.err === null
  };
}

// Main function to determine transaction type and route accordingly
async function processTransaction(serializedTransaction: string, connection: Connection) {
  // Check first two characters to determine transaction type
  if (serializedTransaction.startsWith('AQ')) {
    console.log('Detected versioned transaction (AQ)');
    return await simulateVersionedTransactionWithBalanceChanges(serializedTransaction, connection);
  } else if (serializedTransaction.startsWith('Ag')) {
    console.log('Detected legacy transaction (Ag)');
    return await simulateTransactionWithBalanceChanges(serializedTransaction, connection);
  } else {
    console.log('Unknown transaction format');
    throw new Error('Unsupported transaction format');
  }
}

// Example usage
(async () => {
  
  const versionedTransaction = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAFDim1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyNxBrinkyKcWM0yri8Ob6fbj2ETlWbB74B2SrzsZMN6A9t1pWG6qWtPmFmciR1xbrt4IW+b1nNcz2N5abYbCcsD9iwFDVuHpyk28PYr+9CAgWO/l9LdgXeL6HCQ71KJdFZ0EED+QHqrBQRqB+cbMfYZjXZcTe9r+CfdbguirL8P6FtfLgAwNx3ulhTypPGpaPBqL7YKIanqHyZUBzfZ92pcqzE8vSLSTHcEV4RZJ24keyY1IEiqEBIuF/lRU2zPtY442SSQwcoMhg0j1nITMllFzOB/lJpdC1NPImviWB9UDvr8LArPwq0+kT4lW5cxZc4aLaNGWm3qHL2wMSSVrwgQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E49RPixdukLDvYMw2r2DTumX5VA1ifoAVfXgkOTnLswDErQ/+if11/ZKdMCbHylYed5LCas238ndUUsyGqezjOXovAfFbmCtPT8Xc4LqxlSPuh/TLP2QygKz58+hhf3Oc5jFqWANStTLVr7WONa/Ohja64tn4xB1g5TxvSi6C5uMxQMJAAUCIB8DAAkACQNvdQcAAAAAAAolFgsAAwIBBhkNCgoMChoLFRQTBAIWGxgLFw4EAQ8REhYFEAcICinBIJszQdacgQMCAAAAPQFkAAEaZAECQEtMAAAAAACtXqJ7CAAAADIAAAJOgLKSmCyUmuksqMclFoVdtmiFizz7/yF11zNd6VSAxgUjJCAeHQQOISJxXebA5bRGJSJ69exFtoMFfhkdbXv3/0Pj0l8x1dXoHawDum+4Arlw';
  
  const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
  
  try {
    const result = await processTransaction(versionedTransaction, connection);
    
    // Display a summary of the transaction results
    if (result && result.transactionInfo) {    
      if (result.success) {
        console.log('Transaction simulation succeeded');
      } else {
        console.log('Transaction simulation failed');
      }
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
})();