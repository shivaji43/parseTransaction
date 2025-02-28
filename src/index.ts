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
import { TokenAsset, WalletBalanceChange , simulateVersionedTransactionWithBalanceChanges , fetchTokenInfo} from './versioned';


interface TransactionInfo {
  account: string; // This will hold the wallet public key (owner), not the token account
  assets: TokenAsset;
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
            amount: postInfo.amount,
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
  
  const versionedTransaction = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAIDym1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyP2LAUNW4enKTbw9iv70ICBY7+X0t2Bd4vocJDvUol0VMr9my9KM7fPrQ2sSAQsgz5lHXoh4gfhd4+/UW1KzAU4x0z9lvPICnZqi8nzRoWjCadBBjBEvIdyfVoeaJ12940Jma9ayQ7XJTeurqTvUEjByOL3+y007FpedI9bvzt4vt8bb6Ife3mBYa2q+/aRIB668TE/bopd4zp4RSn/mvPgR4MSYHL0KpzWat0Y0bh7sxC/WDC8z1X2ot8XwBHNQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUDAnDiGwcaoRPMpMbzwSqwxeFGbHA/lPU/ypxDrTePKwfg/25zlUN6V1VjNx5VGHM9DdKxojsE6mEACIKeNoGAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAC0P/on9df2SnTAmx8pWHneSwmrNt/J3VFLMhqns4zl6Mb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11hBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48G3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8Aqb8e7cQBFqNisHD/AFmQHk6/TU5HxQRAg6vx9zxNAyiHBgoABQJQtwMACgAJA5isHQAAAAAABwIAAwwCAAAAKDC3BAAAAAANBQMAIA4HCZPxe2T0hK52/g0oDggAAwUGASAMAg0LDRwIBQQVERAPGh8XHg4dCAQGEhMUFhkbGB4OCSjBIJszQdacgQECAAAAOWQAAThkAQI4EpgEAAAAAAmHqwAAAAAAZAAFDgMDAAABCQJZfTkrqqg0GkW+iGFAaIHEbhkRX4YCBLoWvHI1OH2T2gcACgimTlIFCQMNFAkMAhEHAbjM8yG4Wc/tKkL50v8p4lRCpMnJvnfMN3B0Vb4rQoKUARkBCA==';
  
  const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
  
  try {
    const result = await processTransaction(versionedTransaction, connection);
    
    // Display a summary of the transaction results
    if (result) {    
      if (result.success) {
        console.log(JSON.stringify(result,null,2))
        console.log('Transaction simulation succeeded');
      } else {
        console.log('Transaction simulation failed');
      }
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
})();