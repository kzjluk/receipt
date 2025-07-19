const express = require('express');
const path = require('path');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('.'));

// Store for our monitor instance
let receiptMonitor = null;

// Environment variables for Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

// Simplified AutomatedReceiptMonitor for cloud deployment
class CloudReceiptMonitor {
    constructor(config) {
        this.config = {
            watchFolderId: config.watchFolderId,
            completedFolderId: config.completedFolderId,
            failedFolderId: config.failedFolderId,
            // New invoice folder configuration
            invoiceWatchFolderId: config.invoiceWatchFolderId,
            completedInvoicesFolderId: config.completedInvoicesFolderId,
            failedInvoicesFolderId: config.failedInvoicesFolderId,
            spreadsheetId: config.spreadsheetId,
            togetherApiKey: config.togetherApiKey || TOGETHER_API_KEY,
            checkInterval: config.checkInterval || 60000,
            ...config
        };
        
        this.isRunning = false;
        this.processedFiles = new Set();
        this.processedInvoices = new Set();
        this.stats = {
            totalProcessed: 0,
            successfulParsing: 0,
            errors: 0,
            lastCheck: null,
            // Invoice stats
            totalInvoicesProcessed: 0,
            successfulInvoiceParsing: 0,
            invoiceErrors: 0
        };

        // Google tokens from environment
        this.googleTokens = {
            access_token: GOOGLE_ACCESS_TOKEN,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET
        };
    }

    async start() {
        if (this.isRunning) {
            console.log('📋 Monitor is already running');
            return;
        }

        console.log('🚀 Starting Cloud Receipt & Invoice Monitor');
        console.log('==========================================');
        console.log('📋 RECEIPTS:');
        console.log(`  📁 Watch Folder: ${this.config.watchFolderId}`);
        console.log(`  ✅ Completed Folder: ${this.config.completedFolderId}`);
        console.log(`  ❌ Failed Folder: ${this.config.failedFolderId}`);
        console.log('🧾 INVOICES:');
        console.log(`  📁 Watch Folder: ${this.config.invoiceWatchFolderId}`);
        console.log(`  ✅ Completed Folder: ${this.config.completedInvoicesFolderId}`);
        console.log(`  ❌ Failed Folder: ${this.config.failedInvoicesFolderId}`);
        console.log(`📊 Target Sheet: ${this.config.spreadsheetId}`);
        console.log(`⏰ Check Interval: ${this.config.checkInterval / 1000}s`);
        console.log('');

        this.isRunning = true;
        this.startMonitoring();
    }

    stop() {
        console.log('🛑 Stopping Cloud Receipt Monitor');
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
    }

    startMonitoring() {
        // Initial check
        this.checkForNewReceipts();

        // Set up periodic checking
        this.intervalId = setInterval(() => {
            if (this.isRunning) {
                this.checkForNewReceipts();
            }
        }, this.config.checkInterval);
    }

    async checkForNewReceipts() {
        try {
            console.log(`🔍 [${new Date().toLocaleTimeString()}] Checking for new receipts and invoices...`);
            this.stats.lastCheck = new Date();

            // Refresh tokens if needed
            await this.refreshTokensIfNeeded();

            // Check for new receipts
            await this.checkForNewReceiptFiles();
            
            // Check for new invoices (if invoice folders are configured)
            if (this.config.invoiceWatchFolderId) {
                await this.checkForNewInvoiceFiles();
            }

        } catch (error) {
            console.error('❌ Error checking for files:', error.message);
            this.stats.errors++;
        }
    }

    async checkForNewReceiptFiles() {
        try {
            // Get files from receipt watch folder
            const files = await this.getFilesFromFolder(this.config.watchFolderId);
            
            // Filter for image files that haven't been processed
            const newReceipts = files.filter(file => 
                this.isImageFile(file) && !this.processedFiles.has(file.id)
            );

            if (newReceipts.length === 0) {
                console.log('📭 No new receipts found');
                return;
            }

            console.log(`📸 Found ${newReceipts.length} new receipt(s):`);
            newReceipts.forEach(file => {
                console.log(`  - ${file.name} (${file.id})`);
            });

            // Process each new receipt
            for (const file of newReceipts) {
                await this.processReceipt(file);
            }

        } catch (error) {
            console.error('❌ Error checking for receipts:', error.message);
            this.stats.errors++;
        }
    }

    async checkForNewInvoiceFiles() {
        try {
            // Get files from invoice watch folder
            const files = await this.getFilesFromFolder(this.config.invoiceWatchFolderId);
            
            // Filter for image/PDF files that haven't been processed
            const newInvoices = files.filter(file => 
                this.isDocumentFile(file) && !this.processedInvoices.has(file.id)
            );

            if (newInvoices.length === 0) {
                console.log('📭 No new invoices found');
                return;
            }

            console.log(`🧾 Found ${newInvoices.length} new invoice(s):`);
            newInvoices.forEach(file => {
                console.log(`  - ${file.name} (${file.id})`);
            });

            // Process each new invoice
            for (const file of newInvoices) {
                await this.processInvoice(file);
            }

        } catch (error) {
            console.error('❌ Error checking for invoices:', error.message);
            this.stats.invoiceErrors++;
        }
    }

    async refreshTokensIfNeeded() {
        // Check if access token is expired by making a test request
        try {
            const testUrl = 'https://www.googleapis.com/drive/v3/about?fields=user';
            const response = await fetch(testUrl, {
                headers: {
                    'Authorization': `Bearer ${this.googleTokens.access_token}`
                }
            });

            if (response.status === 401) {
                console.log('🔄 Access token expired, refreshing...');
                await this.refreshAccessToken();
            }
        } catch (error) {
            console.log('🔄 Error testing token, attempting refresh...');
            await this.refreshAccessToken();
        }
    }

    async refreshAccessToken() {
        const refreshUrl = 'https://oauth2.googleapis.com/token';
        const response = await fetch(refreshUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: this.googleTokens.client_id,
                client_secret: this.googleTokens.client_secret,
                refresh_token: this.googleTokens.refresh_token,
                grant_type: 'refresh_token'
            })
        });

        if (!response.ok) {
            throw new Error('Failed to refresh access token');
        }

        const tokenData = await response.json();
        this.googleTokens.access_token = tokenData.access_token;
        
        console.log('✅ Access token refreshed successfully');
    }

    async processReceipt(file) {
        try {
            console.log(`\n🔄 Processing Receipt: ${file.name}`);
            
            // Step 1: Download the file
            console.log('📥 Downloading file...');
            const imageData = await this.downloadFile(file.id);
            
            // Step 2: Parse with AI
            console.log('🤖 Parsing with AI...');
            const receiptData = await this.parseReceiptWithAI(imageData);
            
            // Step 3: Generate image link
            const imageLink = `https://drive.google.com/file/d/${file.id}/view`;
            receiptData.imageLink = imageLink;
            
            // Step 4: Add to Google Sheets (Receipts tab)
            console.log('📊 Adding to Google Sheets (Receipts)...');
            await this.addToGoogleSheets(receiptData, file.name);
            
            // Step 5: Move to completed folder
            console.log('📁 Moving to completed folder...');
            await this.moveFileToCompleted(file.id);
            
            // Mark as processed
            this.processedFiles.add(file.id);
            this.stats.totalProcessed++;
            this.stats.successfulParsing++;
            
            console.log(`✅ Successfully processed receipt: ${file.name}`);
            console.log(`📋 Extracted: ${receiptData.vendor || 'Unknown'} - ${receiptData.total || 'Unknown'}`);
            console.log(`🔗 Image link: ${imageLink}`);
            
        } catch (error) {
            console.error(`❌ Error processing receipt ${file.name}:`, error.message);
            this.stats.errors++;
            
            // Move failed file to failed folder and log to sheet
            await this.handleFailedReceipt(file, error);
            
            // Mark as processed to avoid retry loops
            this.processedFiles.add(file.id);
        }
    }

    async processInvoice(file) {
        try {
            console.log(`\n🔄 Processing Invoice: ${file.name}`);
            
            // Step 1: Download the file
            console.log('📥 Downloading invoice...');
            const imageData = await this.downloadFile(file.id);
            
            // Step 2: Parse with AI for invoice data
            console.log('🤖 Parsing invoice with AI...');
            const invoiceData = await this.parseInvoiceWithAI(imageData);
            
            // Step 3: Generate invoice link
            const invoiceLink = `https://drive.google.com/file/d/${file.id}/view`;
            invoiceData.invoiceLink = invoiceLink;
            
            // Step 4: Add to Google Sheets (Invoice Items tab)
            console.log('📊 Adding to Google Sheets (Invoice Items)...');
            await this.addInvoiceToGoogleSheets(invoiceData, file.name);
            
            // Step 5: Move to completed invoices folder
            console.log('📁 Moving to completed invoices folder...');
            await this.moveInvoiceToCompleted(file.id);
            
            // Mark as processed
            this.processedInvoices.add(file.id);
            this.stats.totalInvoicesProcessed++;
            this.stats.successfulInvoiceParsing++;
            
            console.log(`✅ Successfully processed invoice: ${file.name}`);
            console.log(`🧾 Extracted ${invoiceData.items?.length || 0} items from ${invoiceData.supplier || 'Unknown'}`);
            console.log(`🔗 Invoice link: ${invoiceLink}`);
            
        } catch (error) {
            console.error(`❌ Error processing invoice ${file.name}:`, error.message);
            this.stats.invoiceErrors++;
            
            // Move failed invoice to failed folder and log to sheet
            await this.handleFailedInvoice(file, error);
            
            // Mark as processed to avoid retry loops
            this.processedInvoices.add(file.id);
        }
    }

    async getFilesFromFolder(folderId) {
        const query = `'${folderId}' in parents and trashed=false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Google Drive API error: ${response.status}`);
        }

        const data = await response.json();
        return data.files || [];
    }

    async downloadFile(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        
        return `data:${contentType};base64,${base64}`;
    }

    async parseReceiptWithAI(imageData) {
        const requestBody = {
            model: "meta-llama/Llama-Vision-Free",
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `Please analyze this receipt image and extract the following information in JSON format:
                        {
                            "vendor": "business name",
                            "date": "YYYY-MM-DD format",
                            "total": "total amount including currency symbol",
                            "subtotal": "subtotal before tax",
                            "tax": "tax amount",
                            "payment_method": "cash/card/etc",
                            "card_last_four": "last 4 digits of credit card if visible (e.g., '1234')",
                            "category": "food/gas/retail/etc",
                            "items": ["list of individual items if visible"]
                        }
                        
                        Look for credit card numbers that appear as: ****1234, xxxx1234, or similar patterns.
                        Return only the JSON object, no other text.`
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageData
                        }
                    }
                ]
            }],
            max_tokens: 1000,
            temperature: 0.1
        };

        const response = await fetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.togetherApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Together API error: ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        const jsonString = jsonMatch ? jsonMatch[0] : responseText;
        
        return JSON.parse(jsonString);
    }

    async parseInvoiceWithAI(imageData) {
        const requestBody = {
            model: "meta-llama/Llama-Vision-Free",
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `Please analyze this supplier invoice image and extract detailed item pricing information in JSON format:
                        {
                            "supplier": "supplier/vendor name",
                            "invoice_number": "invoice number",
                            "date": "YYYY-MM-DD format",
                            "total": "total invoice amount including currency symbol",
                            "tax": "tax amount if visible",
                            "items": [
                                {
                                    "description": "item name/description",
                                    "quantity": "quantity ordered",
                                    "unit_price": "price per unit including currency symbol",
                                    "total_price": "total for this line item",
                                    "sku": "product code/SKU if visible"
                                }
                            ]
                        }
                        
                        Focus on extracting individual item details with their specific prices. Look for line items, product codes, quantities, and unit prices. This is for tracking supplier pricing data.
                        Return only the JSON object, no other text.`
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageData
                        }
                    }
                ]
            }],
            max_tokens: 2000,
            temperature: 0.1
        };

        const response = await fetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.togetherApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Together API error: ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        const jsonString = jsonMatch ? jsonMatch[0] : responseText;
        
        return JSON.parse(jsonString);
    }

    async addToGoogleSheets(receiptData, filename) {
        // Get current sheet data to determine next row (Receipts tab)
        const currentDataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/Receipts`;
        const currentResponse = await fetch(currentDataUrl, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        const currentData = await currentResponse.json();
        const nextRow = currentData.values ? currentData.values.length + 1 : 1;

        // Add headers if first row
        if (nextRow === 1) {
            await this.addHeadersToSheet();
        }

        // Add the receipt data with clickable image link
        await this.addReceiptRowWithHyperlink(receiptData, filename, nextRow);
    }

    async addInvoiceToGoogleSheets(invoiceData, filename) {
        // Ensure the Invoice Items tab exists
        await this.ensureInvoiceItemsTabExists();

        // Get current invoice sheet data
        const currentDataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/'Invoice Items'`;
        const currentResponse = await fetch(currentDataUrl, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        const currentData = await currentResponse.json();
        const nextRow = currentData.values ? currentData.values.length + 1 : 1;

        // Add headers if first row
        if (nextRow === 1) {
            await this.addInvoiceHeadersToSheet();
        }

        // Add each item from the invoice as separate rows
        let currentRowNum = nextRow;
        for (const item of invoiceData.items || []) {
            await this.addInvoiceItemRowWithHyperlink(invoiceData, item, filename, currentRowNum);
            currentRowNum++;
        }

        // If no items were found, add a summary row
        if (!invoiceData.items || invoiceData.items.length === 0) {
            await this.addInvoiceItemRowWithHyperlink(invoiceData, null, filename, currentRowNum);
        }
    }

    async addHeadersToSheet() {
        // Ensure Receipts tab exists first
        await this.ensureReceiptsTabExists();
        
        const headerRange = 'Receipts!A1:L1';
        const headers = [
            'Date', 'Vendor', 'Category', 'Total', 'Subtotal', 'Tax', 
            'Payment Method', 'Card Last 4', 'Items', 'Source File', 
            'Image Link', 'Processed'
        ];

        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`;
        
        await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [headers] })
        });
    }

    async addInvoiceHeadersToSheet() {
        const headerRange = "'Invoice Items'!A1:K1";
        const headers = [
            'Date', 'Supplier', 'Invoice Number', 'Item Description', 'Quantity', 
            'Unit Price', 'Total Price', 'SKU', 'Source File', 'Invoice Link', 'Processed'
        ];

        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`;
        
        await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [headers] })
        });
    }

    async ensureReceiptsTabExists() {
        try {
            // Try to get the Receipts sheet
            const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}`;
            const response = await fetch(sheetUrl, {
                headers: {
                    'Authorization': `Bearer ${this.googleTokens.access_token}`
                }
            });

            const spreadsheetData = await response.json();
            const receiptsSheet = spreadsheetData.sheets?.find(sheet => 
                sheet.properties.title === 'Receipts'
            );

            // If Receipts tab doesn't exist, rename Sheet1 or create it
            if (!receiptsSheet) {
                const sheet1 = spreadsheetData.sheets?.find(sheet => 
                    sheet.properties.title === 'Sheet1'
                );
                
                if (sheet1) {
                    // Rename Sheet1 to Receipts
                    await this.renameSheet(sheet1.properties.sheetId, 'Receipts');
                } else {
                    // Create Receipts tab
                    await this.createReceiptsTab();
                }
            }
        } catch (error) {
            // If error, try to create the tab
            await this.createReceiptsTab();
        }
    }

    async ensureInvoiceItemsTabExists() {
        try {
            // Try to get the Invoice Items sheet
            const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}`;
            const response = await fetch(sheetUrl, {
                headers: {
                    'Authorization': `Bearer ${this.googleTokens.access_token}`
                }
            });

            const spreadsheetData = await response.json();
            const invoiceSheet = spreadsheetData.sheets?.find(sheet => 
                sheet.properties.title === 'Invoice Items'
            );

            // If Invoice Items tab doesn't exist, create it
            if (!invoiceSheet) {
                await this.createInvoiceItemsTab();
            }
        } catch (error) {
            // If error, try to create the tab
            await this.createInvoiceItemsTab();
        }
    }

    async renameSheet(sheetId, newName) {
        const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}:batchUpdate`;
        
        const batchUpdateBody = {
            requests: [{
                updateSheetProperties: {
                    properties: {
                        sheetId: sheetId,
                        title: newName
                    },
                    fields: 'title'
                }
            }]
        };

        await fetch(batchUpdateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchUpdateBody)
        });
    }

    async createReceiptsTab() {
        const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}:batchUpdate`;
        
        const batchUpdateBody = {
            requests: [{
                addSheet: {
                    properties: {
                        title: 'Receipts',
                        gridProperties: {
                            rowCount: 1000,
                            columnCount: 12
                        }
                    }
                }
            }]
        };

        await fetch(batchUpdateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchUpdateBody)
        });
    }

    async createInvoiceItemsTab() {
        const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}:batchUpdate`;
        
        const batchUpdateBody = {
            requests: [{
                addSheet: {
                    properties: {
                        title: 'Invoice Items',
                        gridProperties: {
                            rowCount: 1000,
                            columnCount: 11
                        }
                    }
                }
            }]
        };

        await fetch(batchUpdateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchUpdateBody)
        });
    }

    async addReceiptRowWithHyperlink(receiptData, filename, rowNumber) {
        // Use batchUpdate to properly format the hyperlink
        const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}:batchUpdate`;
        
        const rowData = [
            { userEnteredValue: { stringValue: receiptData.date || '' } },
            { userEnteredValue: { stringValue: receiptData.vendor || '' } },
            { userEnteredValue: { stringValue: receiptData.category || '' } },
            { userEnteredValue: { stringValue: receiptData.total || '' } },
            { userEnteredValue: { stringValue: receiptData.subtotal || '' } },
            { userEnteredValue: { stringValue: receiptData.tax || '' } },
            { userEnteredValue: { stringValue: receiptData.payment_method || '' } },
            { userEnteredValue: { stringValue: receiptData.card_last_four || '' } },
            { userEnteredValue: { stringValue: receiptData.items ? receiptData.items.join('; ') : '' } },
            { userEnteredValue: { stringValue: filename } },
            // Make the image link clickable
            receiptData.imageLink ? {
                userEnteredValue: {
                    formulaValue: `=HYPERLINK("${receiptData.imageLink}","View Receipt")`
                }
            } : { userEnteredValue: { stringValue: '' } },
            { userEnteredValue: { stringValue: new Date().toISOString() } }
        ];

        const batchUpdateBody = {
            requests: [{
                updateCells: {
                    range: {
                        sheetId: 0,
                        startRowIndex: rowNumber - 1,
                        endRowIndex: rowNumber,
                        startColumnIndex: 0,
                        endColumnIndex: 12
                    },
                    rows: [{
                        values: rowData
                    }],
                    fields: 'userEnteredValue'
                }
            }]
        };

        await fetch(batchUpdateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchUpdateBody)
        });
    }

    async moveFileToCompleted(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${this.config.completedFolderId}&removeParents=${this.config.watchFolderId}`;
        
        await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });
    }

    async moveFileToFailed(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${this.config.failedFolderId}&removeParents=${this.config.watchFolderId}`;
        
        await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });
    }

    async handleFailedReceipt(file, error) {
        try {
            console.log(`📁 Moving failed receipt to failed folder: ${file.name}`);
            
            // Move file to failed folder
            await this.moveFileToFailed(file.id);
            
            // Generate link to failed file
            const failedImageLink = `https://drive.google.com/file/d/${file.id}/view`;
            
            // Create failure record in Google Sheets
            await this.addFailureToGoogleSheets(file.name, error.message, failedImageLink);
            
            console.log(`❌ Failed receipt logged: ${file.name}`);
            
        } catch (handleError) {
            console.error(`❌ Error handling failed receipt: ${handleError.message}`);
        }
    }

    async addFailureToGoogleSheets(filename, errorMessage, imageLink) {
        // Similar to addToGoogleSheets but for failures
        const currentDataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/Sheet1`;
        const currentResponse = await fetch(currentDataUrl, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        const currentData = await currentResponse.json();
        const nextRow = currentData.values ? currentData.values.length + 1 : 1;

        const failureRowData = [
            new Date().toISOString().split('T')[0],
            'PROCESSING FAILED',
            'ERROR',
            '', '', '', '', '',
            `Error: ${errorMessage}`,
            filename,
            imageLink,
            new Date().toISOString()
        ];

        const range = `Sheet1!A${nextRow}:L${nextRow}`;
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
        
        await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [failureRowData] })
        });
    }

    isImageFile(file) {
        const imageMimeTypes = [
            'image/jpeg', 'image/jpg', 'image/png',
            'image/webp', 'image/gif', 'image/bmp'
        ];
        
        return imageMimeTypes.includes(file.mimeType) || 
               /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(file.name);
    }

    isDocumentFile(file) {
        const documentMimeTypes = [
            'image/jpeg', 'image/jpg', 'image/png',
            'image/webp', 'image/gif', 'image/bmp',
            'application/pdf'
        ];
        
        return documentMimeTypes.includes(file.mimeType) || 
               /\.(jpg|jpeg|png|webp|gif|bmp|pdf)$/i.test(file.name);
    }

    async addInvoiceItemRowWithHyperlink(invoiceData, item, filename, rowNumber) {
        // Get the Invoice Items sheet ID
        const sheetId = await this.getSheetIdByName('Invoice Items');
        
        // Use batchUpdate to properly format the hyperlink
        const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}:batchUpdate`;
        
        const rowData = [
            { userEnteredValue: { stringValue: invoiceData.date || '' } },
            { userEnteredValue: { stringValue: invoiceData.supplier || '' } },
            { userEnteredValue: { stringValue: invoiceData.invoice_number || '' } },
            { userEnteredValue: { stringValue: item ? item.description || '' : 'No items found' } },
            { userEnteredValue: { stringValue: item ? item.quantity || '' : '' } },
            { userEnteredValue: { stringValue: item ? item.unit_price || '' : '' } },
            { userEnteredValue: { stringValue: item ? item.total_price || '' : invoiceData.total || '' } },
            { userEnteredValue: { stringValue: item ? item.sku || '' : '' } },
            { userEnteredValue: { stringValue: filename } },
            // Make the invoice link clickable
            invoiceData.invoiceLink ? {
                userEnteredValue: {
                    formulaValue: `=HYPERLINK("${invoiceData.invoiceLink}","View Invoice")`
                }
            } : { userEnteredValue: { stringValue: '' } },
            { userEnteredValue: { stringValue: new Date().toISOString() } }
        ];

        const batchUpdateBody = {
            requests: [{
                updateCells: {
                    range: {
                        sheetId: sheetId,
                        startRowIndex: rowNumber - 1,
                        endRowIndex: rowNumber,
                        startColumnIndex: 0,
                        endColumnIndex: 11
                    },
                    rows: [{
                        values: rowData
                    }],
                    fields: 'userEnteredValue'
                }
            }]
        };

        await fetch(batchUpdateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchUpdateBody)
        });
    }

    async getSheetIdByName(sheetName) {
        const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}`;
        const response = await fetch(sheetUrl, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        const spreadsheetData = await response.json();
        const sheet = spreadsheetData.sheets?.find(sheet => 
            sheet.properties.title === sheetName
        );

        return sheet ? sheet.properties.sheetId : 0;
    }

    async moveInvoiceToCompleted(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${this.config.completedInvoicesFolderId}&removeParents=${this.config.invoiceWatchFolderId}`;
        
        await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });
    }

    async moveInvoiceToFailed(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${this.config.failedInvoicesFolderId}&removeParents=${this.config.invoiceWatchFolderId}`;
        
        await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });
    }

    async handleFailedInvoice(file, error) {
        try {
            console.log(`📁 Moving failed invoice to failed folder: ${file.name}`);
            
            // Move file to failed folder
            await this.moveInvoiceToFailed(file.id);
            
            // Generate link to failed file
            const failedInvoiceLink = `https://drive.google.com/file/d/${file.id}/view`;
            
            // Create failure record in Google Sheets (Invoice Items tab)
            await this.addFailureToInvoiceSheet(file.name, error.message, failedInvoiceLink);
            
            console.log(`❌ Failed invoice logged: ${file.name}`);
            
        } catch (handleError) {
            console.error(`❌ Error handling failed invoice: ${handleError.message}`);
        }
    }

    async addFailureToInvoiceSheet(filename, errorMessage, invoiceLink) {
        // Ensure the Invoice Items tab exists
        await this.ensureInvoiceItemsTabExists();

        // Get current invoice sheet data
        const currentDataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/'Invoice Items'`;
        const currentResponse = await fetch(currentDataUrl, {
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`
            }
        });

        const currentData = await currentResponse.json();
        const nextRow = currentData.values ? currentData.values.length + 1 : 1;

        // Prepare failure row data
        const failureRowData = [
            new Date().toISOString().split('T')[0], // Date
            'PROCESSING FAILED', // Supplier
            '', // Invoice Number
            `Error: ${errorMessage}`, // Item Description (error message)
            '', // Quantity
            '', // Unit Price
            '', // Total Price
            '', // SKU
            filename, // Source File
            invoiceLink, // Invoice Link (to failed folder)
            new Date().toISOString() // Processing timestamp
        ];

        // Add headers if first row
        let range, values;
        if (nextRow === 1) {
            range = "'Invoice Items'!A1:K2";
            values = [
                ['Date', 'Supplier', 'Invoice Number', 'Item Description', 'Quantity', 'Unit Price', 'Total Price', 'SKU', 'Source File', 'Invoice Link', 'Processed'],
                failureRowData
            ];
        } else {
            range = `'Invoice Items'!A${nextRow}:K${nextRow}`;
            values = [failureRowData];
        }

        // Update the sheet
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
        
        await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.googleTokens.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values })
        });
    }

    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            processedFilesCount: this.processedFiles.size,
            processedInvoicesCount: this.processedInvoices.size
        };
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'cloud_interface.html'));
});

app.post('/api/start-monitor', (req, res) => {
    try {
        const config = req.body;
        
        if (!config.watchFolderId || !config.completedFolderId || !config.failedFolderId || !config.spreadsheetId) {
            throw new Error('Missing required receipt processing configuration');
        }

        if (receiptMonitor && receiptMonitor.isRunning) {
            throw new Error('Monitor is already running');
        }

        receiptMonitor = new CloudReceiptMonitor(config);
        receiptMonitor.start();

        let message = 'Cloud receipt monitor started';
        if (config.invoiceWatchFolderId && config.completedInvoicesFolderId && config.failedInvoicesFolderId) {
            message = 'Cloud receipt & invoice monitor started';
        }

        res.json({
            success: true,
            message: message
        });

    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/stop-monitor', (req, res) => {
    try {
        if (receiptMonitor) {
            receiptMonitor.stop();
            receiptMonitor = null;
        }

        res.json({
            success: true,
            message: 'Monitor stopped'
        });

    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/monitor-stats', (req, res) => {
    try {
        const stats = receiptMonitor ? receiptMonitor.getStats() : {
            isRunning: false,
            totalProcessed: 0,
            successfulParsing: 0,
            errors: 0,
            totalInvoicesProcessed: 0,
            successfulInvoiceParsing: 0,
            invoiceErrors: 0,
            lastCheck: null,
            processedFilesCount: 0,
            processedInvoicesCount: 0
        };

        res.json({
            success: true,
            stats: stats
        });

    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        monitor: receiptMonitor ? receiptMonitor.isRunning : false
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Cloud Receipt Monitor running on port ${PORT}`);
    console.log(`📱 Access at: http://localhost:${PORT}`);
    
    // Check if we have required environment variables
    const missing = [];
    if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    if (!GOOGLE_ACCESS_TOKEN) missing.push('GOOGLE_ACCESS_TOKEN');
    if (!GOOGLE_REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');
    if (!TOGETHER_API_KEY) missing.push('TOGETHER_API_KEY');
    
    if (missing.length > 0) {
        console.log('⚠️  Missing environment variables:', missing.join(', '));
        console.log('🔧 Set these before starting the monitor');
    } else {
        console.log('✅ All environment variables configured');
    }
});
