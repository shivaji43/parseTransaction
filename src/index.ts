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
  
  // Get the primary wallet address (first signer)
  const primaryWallet = transaction.signatures[0].publicKey.toBase58();
  console.log(`Primary wallet: ${primaryWallet}`);
  
  // Get the accounts involved in the transaction
  const accounts = transaction.instructions.flatMap(ix => 
    ix.keys.map(key => key.pubkey)
  );
  const uniqueAccounts = [...new Set(accounts.map(acc => acc.toBase58()))];
  console.log(`Transaction involves ${uniqueAccounts.length} unique accounts`);
  
  // Get pre-simulation token balances and SOL balances
  const preBalances = new Map();
  const preSolBalances = new Map();
  
  for (const accountAddress of uniqueAccounts) {
    const pubkey = new PublicKey(accountAddress);
    try {
      const accountInfo = await connection.getAccountInfo(pubkey);
      
      // Store SOL balance for wallet accounts
      if (accountInfo) {
        preSolBalances.set(accountAddress, accountInfo.lamports);
      }
      
      // Check if this is a token account
      if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length === ACCOUNT_SIZE) {
        const decoded = AccountLayout.decode(accountInfo.data);
        const mint = decoded.mint.toString();
        const amount = Number(decoded.amount);
        const owner = decoded.owner.toString(); 
        
        preBalances.set(accountAddress, { mint, amount, owner });
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
    return {
      walletBalanceChange: {
        wallet: primaryWallet,
        buying: [],
        selling: [],
        solChange: 0
      },
      success: false
    };
  }
  
  const postBalances = new Map();
  const postSolBalances = new Map();
  
  // Extract token balances from simulation results
  for (let i = 0; i < simulationResult.value.accounts.length; i++) {
    const account = simulationResult.value.accounts[i];
    
    if (!account) continue;
    
    // Extract the account address from the transaction
    const accountPubkey = uniqueAccounts[i];
    
    // Store SOL balance for all accounts
    if (account.lamports !== undefined) {
      postSolBalances.set(accountPubkey, account.lamports);
    }
    
    // Check if it's a token account
    if (account.owner === TOKEN_PROGRAM_ID.toBase58()) {
      try {
        const data = Buffer.from(account.data[0], 'base64');
        if (data.length === ACCOUNT_SIZE) {
          const decoded = AccountLayout.decode(data);
          const mint = decoded.mint.toString();
          const amount = Number(decoded.amount);
          const owner = decoded.owner.toString(); 
          
          postBalances.set(accountPubkey, { mint, amount, owner });
        }
      } catch (error : any) {
        console.log(`Error decoding account data: ${error.message}`);
      }
    }
  }
  
  // Calculate SOL change for the primary wallet
  let solChange = 0;
  const preSol = preSolBalances.get(primaryWallet) || 0;
  const postSol = postSolBalances.get(primaryWallet) || 0;
  solChange = postSol - preSol;
  
  // Create the wallet balance change structure
  const buying: TokenAsset[] = [];
  const selling: TokenAsset[] = [];
  
  // Process token balance changes by wallet
  const walletChanges = new Map<string, Map<string, number>>();
  
  for (const [address, preInfo] of preBalances.entries()) {
    const postInfo = postBalances.get(address);
    
    if (postInfo) {
      const balanceChange = postInfo.amount - preInfo.amount;
      
      // Only include accounts with balance changes
      if (balanceChange !== 0) {
        // Group changes by wallet and token mint
        if (!walletChanges.has(preInfo.owner)) {
          walletChanges.set(preInfo.owner, new Map<string, number>());
        }
        
        const walletTokenChanges = walletChanges.get(preInfo.owner)!;
        const currentChange = walletTokenChanges.get(preInfo.mint) || 0;
        walletTokenChanges.set(preInfo.mint, currentChange + balanceChange);
      }
    }
  }
  
  // Process wallet token changes for the primary wallet
  const primaryWalletChanges = walletChanges.get(primaryWallet);
  if (primaryWalletChanges) {
    for (const [mint, balanceChange] of primaryWalletChanges.entries()) {
      // Fetch complete token info
      const tokenInfo = await fetchTokenInfo(mint);
      
      // Create the token asset object
      const tokenAsset: TokenAsset = {
        mint,
        balanceChange,
        amount: balanceChange / Math.pow(10, tokenInfo.decimals), // Convert to decimal amount
        logouri: tokenInfo.logouri,
        decimals: tokenInfo.decimals,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name
      };
      
      // Sort into buying or selling based on balance change
      if (balanceChange > 0) {
        buying.push(tokenAsset);
      } else {
        selling.push(tokenAsset);
      }
    }
  }
  
  // Create the final output
  const output = {
    walletBalanceChange: {
      wallet: primaryWallet,
      buying,
      selling
    },
    success: simulationResult.value.err === null
  };
  
  return output;
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
  
  const versionedTransaction = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQALEim1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyP2LAUNW4enKTbw9iv70ICBY7+X0t2Bd4vocJDvUol0Vmf8tThVI2sRkmD2EmMS9/AyOY0sK8kOkTIbTMftjXJHEzfZHfK+df8cHOiMH18Ck85+5FYvbuPgRfoH+q0xHdt3CLIA52L2QtK0SCvw3BHYSSE6EZf38yyKgkxq8qaFvJD7R7MrykQ+ZBtfBnxPPc7nb9gAKhPbS/SITgDsPVtNQkrU04/tjHWGMH9KySCpceIKpVFDz9XAPhnoROTiGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSYdFKrMW8DuxjXahwWh9wo57jWprPC/jyLMbOSQGdeoyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZmoAL/0yHNoiWwg/BQHPr8ctao3X+gf5NvcgrpN+3XnisH4P9uc5VDeldVYzceVRhzPQ3SsaI7BOphAAiCnjaBgMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAtD/6J/XX9kp0wJsfKVh53ksJqzbfyd1RSzIap7OM5ejG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYedK2WzjZZ/TE1EAKEv3eARbhRCo805JjJIu7m/DBfhp9KVDZtJH/43jF12qKxyM52eTU+aqWd2YHCxyDOi1i68EedVb8jHAbu50xW7OaBUH/bGy3qP0jlECsc2iVrwTj6Oo8CiIrTqEj7vpgV88qSbMXT0+0ELo9q8xNdanX/kxBAwABQJf3AIADAAJA9tKCwAAAAAACQYABgAQBxsBAREtGwoAAQIEBg4QBRENER0XDwgVFgMCGBweChsaGxMZExQSExMTExMTExMDBAoLKcEgmzNB1pyBAgIAAAA6AGQAAQdkAQJElKsAAAAAANdm6bYEAAAAZAAKAqMtc6mvbyfgJe+ZVmjDGRB0el+ncnHluY0dxCqecEsoA1ldXAMDBADzc3nWhLWhdOWZIuE5apcuNBcP0Q4AS/ORqB1nPboz8AQSDQwLAw4PEA==';
  
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