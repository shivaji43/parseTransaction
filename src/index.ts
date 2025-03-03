import { Connection } from '@solana/web3.js';
import { simulateVersionedTransactionWithBalanceChanges} from './versioned';

(async () => {
  
  const versionedTransaction = '';
  
  const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
  
  try {
    const result = await simulateVersionedTransactionWithBalanceChanges(versionedTransaction, connection);
    
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