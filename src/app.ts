process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/* Internal dependencies */
import { createApp } from './api/app';

const port = process.env.PORT || 3000;

/* Start the Express server */
createApp().listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
