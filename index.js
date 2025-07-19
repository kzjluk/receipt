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
            spreadsheetId: config.spreadsheetId,
            togetherApiKey: config.togetherApiKey || TOGETHER_API_KEY,
            checkInterval: config.checkInterval || 60000,
            ...config
        };
        
        this.isRunning = false;
        this.processedFiles = new Set();
        this.stats = {
            totalProcessed: 0,
            successfulParsing: 0,
            errors: 0,
            lastCheck: null
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

        console.log('🚀 Starting Cloud Receipt Monitor');
        console.log('==================================');
        console.log(`📁 Watch Folder: ${this.config.watchFolderId}`);
        console.log(`✅ Completed Folder: ${this.config.completedFolderId}`);
        console.log(`❌ Failed Folder: ${this.config.failedFolderId}`);
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
            console.log(`🔍 [${new Date().toLocaleTimeString()}] Checking for new receipts...`);
            this.stats.lastCheck = new Date();

            // Refresh tokens if needed
            await this.refreshTokensIfNeeded();

            // Get files from watch folder
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
            console.log(`\n🔄 Processing: ${file.name}`);
            
            // Step 1: Download the file
            console.log('📥 Downloading file...');
            const imageData = await this.downloadFile(file.id);
            
            // Step 2: Parse with AI
            console.log('🤖 Parsing with AI...');
            const receiptData = await this.parseReceiptWithAI(imageData);
            
            // Step 3: Generate image link
            const imageLink = `https://drive.google.com/file/d/${file.id}/view`;
            receiptData.imageLink = imageLink;
            
            // Step 4: Add to Google Sheets
            console.log('📊 Adding to Google Sheets...');
            await this.addToGoogleSheets(receiptData, file.name);
            
            // Step 5: Move to completed folder
            console.log('📁 Moving to completed folder...');
            await this.moveFileToCompleted(file.id);
            
            // Mark as processed
            this.processedFiles.add(file.id);
            this.stats.totalProcessed++;
            this.stats.successfulParsing++;
            
            console.log(`✅ Successfully processed: ${file.name}`);
            console.log(`📋 Extracted: ${receiptData.vendor || 'Unknown'} - ${receiptData.total || 'Unknown'}`);
            console.log(`🔗 Image link: ${imageLink}`);
            
        } catch (error) {
            console.error(`❌ Error processing ${file.name}:`, error.message);
            this.stats.errors++;
            
            // Move failed file to failed folder and log to sheet
            await this.handleFailedReceipt(file, error);
            
            // Mark as processed to avoid retry loops
            this.processedFiles.add(file.id);
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

    async addToGoogleSheets(receiptData, filename) {
        // Get current sheet data to determine next row
        const currentDataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.config.spreadsheetId}/values/Sheet1`;
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

    async addHeadersToSheet() {
        const headerRange = 'Sheet1!A1:L1';
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

    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            processedFilesCount: this.processedFiles.size
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
            throw new Error('Missing required configuration');
        }

        if (receiptMonitor && receiptMonitor.isRunning) {
            throw new Error('Monitor is already running');
        }

        receiptMonitor = new CloudReceiptMonitor(config);
        receiptMonitor.start();

        res.json({
            success: true,
            message: 'Cloud receipt monitor started'
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
            lastCheck: null,
            processedFilesCount: 0
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