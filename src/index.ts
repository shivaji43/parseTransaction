import {
    Connection,
    Transaction,
    PublicKey,
  } from '@solana/web3.js';
  import {
    AccountLayout,
    ACCOUNT_SIZE,
    TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  
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
    
    
    return {
      preBalances: Object.fromEntries(preBalances),
      postBalances: Object.fromEntries(postBalances),
      success: simulationResult.value.err === null
    };
  }
  
  (async () => {
    const serializedTransaction = 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhLJcbdP1NVjJjlPn9ha63QzFkcC0oTFKwfW4FbOGcqQpWldXGM3PouCEzNDjLF0BFRt7X8KRqSqshy2iEth4LAgAIDim1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyqSfS21hJ+oTOehEXEYBeaNqsydDYjZqf1L/AldJw2uQ/YsBQ1bh6cpNvD2K/vQgIFjv5fS3YF3i+hwkO9SiXRW0cZ5LhNGqUuyoosHzgX4qKklM/mXZfbY5P3YFhXjGW4/sQewNuB49c0ItC0YuhAl7tWg5lLqRAUWJ1eTBUAbrorDARlJnx/94mezVZ6s5V56HXcSBjUrqqlmxC7OQwZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpM4q6xj0HkaERh2Zuqn+xa51t3JEl5PL8COT42q2vaDeMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4Wcb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11h870t5h5iwpEaFSbn0ADhmHWooZImTFM6LC9B7H84XZh+rfUD/HWv9ZtYg614vrD+ULGGEfOeQNYlW4/QZzr4TQUHAAUCQA0DAAcACQNAQg8AAAAAAAoKAQACDA0EBQkLBhiK4+hN36ZgxR+OGSQl4q0xONqqAAAAAAAIAQEsRGVwb3NpdCA2YzYzZWYzZS00ODU3LTQ0YjQtYTU4NC0wNDE5MDk4NGM4NzcGAgADDAIAAADVqTsAAAAAAA==';
    const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
    
    await simulateTransactionWithBalanceChanges(serializedTransaction, connection);
  })();