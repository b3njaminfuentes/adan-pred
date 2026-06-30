import { reportPaperBet } from './src/api/brier-reporter.js';

async function run() {
  await reportPaperBet({
    market: {
      id: '0x1111222233334444555566667777888899990000',
      conditionId: '0x1111222233334444555566667777888899990000',
      title: 'Will ADAN successfully migrate to Brier SDK?',
      yesPrice: 0.6
    },
    side: 'YES',
    stake: 100,
    tradeId: 'test-123'
  });
  console.log('Done');
}
run();
