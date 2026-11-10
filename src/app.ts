process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/* Internal dependencies */
import { createApp } from './api/app';
import { getPayoutStore } from './payouts/store';

const port = process.env.PORT || 3000;

// Open the payout journal now rather than on the first request: payouts cut by the previous restart turn `unknown`
const journal = getPayoutStore();
// Drop final payouts older than PAYOUT_RETENTION_DAYS (default 30) a few times a day
setInterval(() => journal.prune(), 6 * 60 * 60 * 1000).unref();

/* Start the Express server */
createApp().listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
