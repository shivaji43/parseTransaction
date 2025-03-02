import {
  Connection,
  Transaction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
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
  
  // Get the first signer's wallet address (typically the user's wallet)
  const firstSignerWallet = transaction.signatures[0]?.publicKey.toBase58();
  //console.log(`First signer wallet: ${firstSignerWallet}`);
  
  // Track SOL balances and token balances
  const preBalances = new Map();
  
  // Get SOL balance for the first signer
  if (firstSignerWallet) {
    try {
      const solBalance = await connection.getBalance(new PublicKey(firstSignerWallet));
      preBalances.set(`SOL:${firstSignerWallet}`, {
        mint: 'So11111111111111111111111111111111111111112',
        amount: solBalance,
        owner: firstSignerWallet
      });
    } catch (error : any) {
      console.log(`Error fetching SOL balance: ${error.message}`);
    }
  }
  
  // Get pre-simulation token balances 
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
        
        // Only track token accounts owned by the first signer
        if (owner === firstSignerWallet) {
          preBalances.set(`${mint}:${accountAddress}`, { mint, amount, owner, tokenAccount: accountAddress })
        }
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
    return { success: simulationResult.value.err === null };
  }
  
  // Extract post-simulation token balances
  const postBalances = new Map();
  
  // Find the signer's SOL account in the simulation results
  if (firstSignerWallet) {
    const signerAccountIndex = 0;
    
    if (signerAccountIndex >= 0 && simulationResult.value.accounts[signerAccountIndex]) {
      const postSolBalance = BigInt(simulationResult.value.accounts[signerAccountIndex].lamports || 0);
      
      postBalances.set(`SOL:${firstSignerWallet}`, {
        mint: 'So11111111111111111111111111111111111111112',
        amount: Number(postSolBalance),
        owner: firstSignerWallet
      });
    }
  }
  
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
          const owner = decoded.owner.toString();
          
          // Only track token accounts owned by the first signer
          if (owner === firstSignerWallet) {
            postBalances.set(`${mint}:${accountPubkey}`, { mint, amount, owner, tokenAccount: accountPubkey });
          }
        }
      } catch (error : any) {
        console.log(`Error decoding account data: ${error.message}`);
      }
    }
  }
  
  // Calculate balance changes
  const tokensBought = [];
  const tokensSold = [];
  
  // Process SOL balance changes
  const preSolBalance = preBalances.get(`SOL:${firstSignerWallet}`)?.amount || 0;
  const postSolBalance = postBalances.get(`SOL:${firstSignerWallet}`)?.amount || 0;
  
  if (preSolBalance !== postSolBalance) {
    const solBalanceChange = postSolBalance - preSolBalance;
    const tokenInfo = await fetchTokenInfo('So11111111111111111111111111111111111111112');
    
    if (solBalanceChange > 0) {
      // Bought SOL
      tokensBought.push({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        amount: solBalanceChange / LAMPORTS_PER_SOL,
        rawAmount: solBalanceChange,
        decimals: tokenInfo.decimals,
        logouri: tokenInfo.logouri
      });
    } else if (solBalanceChange < 0) {
      // Sold SOL
      tokensSold.push({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        amount: Math.abs(solBalanceChange) / LAMPORTS_PER_SOL,
        rawAmount: Math.abs(solBalanceChange),
        decimals: tokenInfo.decimals,
        logouri: tokenInfo.logouri
      });
    }
  }
  
  // Create a map to group token accounts by mint
  const preMintTotals = new Map();
  const postMintTotals = new Map();
  
  // Group pre-simulation balances by mint
  for (const [key, value] of preBalances.entries()) {
    if (key.startsWith('SOL:')) continue; // Skip SOL entries
    
    const { mint, amount } = value;
    const currentTotal = preMintTotals.get(mint) || 0;
    preMintTotals.set(mint, currentTotal + amount);
  }
  
  // Group post-simulation balances by mint
  for (const [key, value] of postBalances.entries()) {
    if (key.startsWith('SOL:')) continue; // Skip SOL entries
    
    const { mint, amount } = value;
    const currentTotal = postMintTotals.get(mint) || 0;
    postMintTotals.set(mint, currentTotal + amount);
  }
  
  // Calculate net changes for each token mint
  const allMints = new Set([...preMintTotals.keys(), ...postMintTotals.keys()]);
  
  for (const mint of allMints) {
    const preTotal = preMintTotals.get(mint) || 0;
    const postTotal = postMintTotals.get(mint) || 0;
    const difference = postTotal - preTotal;
    
    if (difference !== 0) {
      // Fetch token info
      const tokenInfo = await fetchTokenInfo(mint);
      
      if (difference > 0) {
        // Token amount increased (bought)
        tokensBought.push({
          mint,
          symbol: tokenInfo.symbol,
          amount: difference / Math.pow(10, tokenInfo.decimals),
          rawAmount: difference,
          decimals: tokenInfo.decimals,
          logouri: tokenInfo.logouri
        });
      } else {
        // Token amount decreased (sold)
        tokensSold.push({
          mint,
          symbol: tokenInfo.symbol,
          amount: Math.abs(difference) / Math.pow(10, tokenInfo.decimals),
          rawAmount: Math.abs(difference),
          decimals: tokenInfo.decimals,
          logouri: tokenInfo.logouri
        });
      }
    }
  }
  
  return {
    wallet: firstSignerWallet,
    tokensSold,
    tokensBought,
    success: simulationResult.value.err === null
  };
}

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

(async () => {
  
  const versionedTransaction = 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAlW6fyoFAT98Wk2mCGT2G9opjT/ahdz4CvnbQq0HlNW2DlVZ2YdH/qeCtwV/hI26Ug0mwep26MMOD0JnELIwEAgAIDim1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyqSfS21hJ+oTOehEXEYBeaNqsydDYjZqf1L/AldJw2uQL2sxJFKqOVaRG8Vzr1XIppEEcLhWaNkZ946rfzxYFzz9iwFDVuHpyk28PYr+9CAgWO/l9LdgXeL6HCQ71KJdFbRxnkuE0apS7KiiwfOBfioqSUz+Zdl9tjk/dgWFeMZazDCGa6UwFLt54BEg8qRdUt92HAOXuisKkToeHYVjeSQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpM4q6xj0HkaERh2Zuqn+xa51t3JEl5PL8COT42q2vaDeMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4Wcb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11h870t5h5iwpEaFSbn0ADhmHWooZImTFM6LC9B7H84XZjk5vGGlh4fAUG9Uao3uVrZU73ucD8rAgTn//H/PbdFoQUHAAUCQA0DAAcACQNAQg8AAAAAAAoKAQADDA0CBQkLBhiK4+hN36Zgxff1HEgLnQtWcIapAAAAAAAIAQEsRGVwb3NpdCAzNmI3MWM5OC1lZmMwLTQ5MWUtOWY2NC00NGIxZjRkNjk1MGMGAgAEDAIAAABwCDsAAAAAAA==';
  
  const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
  
  try {
    const result = await processTransaction(versionedTransaction, connection);
    
    // Display a summary of the transaction results
    if (result) {    
      if (result) {
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