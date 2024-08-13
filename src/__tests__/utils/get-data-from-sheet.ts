/* External dependencies */
import fs from 'fs';
import * as dotenv from 'dotenv';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';

dotenv.config();

/* Internal dependencies */
import { isJson } from './modules';

/* Constants */
import { ConstTest } from '../constants/const';

// Define command-line arguments and constants
const myArgs: string[] = process.argv.slice(2);
const PATH_TO_TEST_DATA_FOLDER = ConstTest.PATH_FOR_TEST_DATA;

/**
 * Retrieves test data from a Google Spreadsheet and saves it to a JSON file.
 */
(async () => {
    try {
        // Initialize authentication with necessary scopes and credentials
        const serviceAccountAuth = new JWT({
            email: process.env.AUTOMATION_SERVICE_EMAIL as string,
            key: (process.env.AUTOMATION_SERVICE_PRIVATE_KEY as string).replace(/\\n/g, '\n'),
            scopes: process.env.AUTOMATION_SERVICE_SCOPES as string,
        });

        // Create an instance of GoogleSpreadsheet with the spreadsheet ID and authentication
        const doc = new GoogleSpreadsheet(process.env.AUTOMATION_GOOGLE_TOKEN as string, serviceAccountAuth);

        // Authenticate and load spreadsheet information
        await doc.loadInfo();
        console.log(`Loaded document: ${doc.title}`);

        // Get the sheet by index provided as a command-line argument
        const sheetIndex: number = parseInt(myArgs[0], 10);
        if (isNaN(sheetIndex) || sheetIndex < 0 || sheetIndex >= doc.sheetCount) {
            throw new Error('Invalid sheet index provided.');
        }
        const sheet = doc.sheetsByIndex[sheetIndex];

        // Retrieve all rows from the sheet
        const rows = await sheet.getRows();
        const testDataJSON: Record<string, any>[] = [];
        const columnNames = sheet.headerValues;

        // Process each row to create a JSON representation
        for (const row of rows) {
            const testElementJSON: Record<string, any> = {};

            for (const column of columnNames) {
                const cellValue = row.get(column);
                if (cellValue !== undefined && cellValue !== '') {
                    // Parse JSON values if necessary
                    testElementJSON[column] = isJson(cellValue)
                        ? JSON.parse(cellValue)
                        : cellValue;
                }
            }

            // Only include rows that have a tag column
            if (columnNames.includes(ConstTest.TAG)) {
                testDataJSON.push(testElementJSON);
            }
        }

        // Write the processed test data to a JSON file
        fs.writeFile(`${PATH_TO_TEST_DATA_FOLDER}${myArgs[1]}`, JSON.stringify(testDataJSON, null, ConstTest.TAB), (err) => {
            if (err) {
                console.error('Error writing file:', err);
                throw err;
            }
            console.log(`Data has been written to file ${PATH_TO_TEST_DATA_FOLDER}${myArgs[1]}`);
        });
    } catch (error) {
        console.error('An error occurred:', error);
    }
})();
