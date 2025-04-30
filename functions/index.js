const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // install if needed: npm install node-fetch

require('dotenv').config(); // load .env into process.env if running locally

admin.initializeApp();

const isLocal = !process.env.FUNCTION_NAME; // Firebase emulator doesn't set this

const getEnvVar = (key, path) =>
    isLocal ? process.env[key] : functions.config()[path.split('.')[0]][path.split('.')[1]];

const ZOOM_ACCOUNT_ID = getEnvVar('ZOOM_ACCOUNT_ID', 'zoom.account_id');

const ZOOM_CLIENT_ID = getEnvVar('ZOOM_CLIENT_ID', 'zoom.client_id');

const ZOOM_CLIENT_SECRET = getEnvVar('ZOOM_CLIENT_SECRET', 'zoom.client_secret');

const MAILCHIMP_API_KEY = getEnvVar('MAILCHIMP_API_KEY', 'mailchimp.api_key');
const MAILCHIMP_SERVER_PREFIX = getEnvVar('MAILCHIMP_SERVER_PREFIX', 'mailchimp.server_prefix');
const MAILCHIMP_LIST_ID = getEnvVar('MAILCHIMP_LIST_ID', 'mailchimp.list_id');

const HUBSPOT_API_TOKEN = getEnvVar('HUBSPOT_API_TOKEN', 'hubspot.api_token');

async function getZoomAccessToken() {
    const credentials = btoa(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`);
    const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch Zoom access token: ${errorText}`);
    }

    const data = await response.json();
    return data.access_token; // Return fresh token
}

exports.register = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    const {
        firstName,
        lastName,
        email,
        company,
        jobTitle,
        eventId,
        identifier
    } = req.body;

    if (!firstName || !lastName || !email || !eventId || !company) {
        res.status(500).send({
            message: 'Request Error',
            info: "Missing required fields",
            errorAt: "requestBody"
        });
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        res.status(400).send({
            message: 'Request Error',
            info: "Invalid email format",
            errorAt: "requestBody"
        });
        return;
    }

    try {
        const zoomAccessToken = await getZoomAccessToken();

        const zoomResponse = await fetch(`https://api.zoom.us/v2/webinars/${eventId}/registrants`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${zoomAccessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: email,
                first_name: firstName,
                last_name: lastName,
                org: company,
            })
        });

        if (!zoomResponse.ok) {
            const errorText = await zoomResponse.text();
            const error = new Error(`Zoom API error: ${errorText}`);
            error.type = "zoom";
            error.text = errorText;
            throw error;
        }

        const zoomData = await zoomResponse.json();

        res.status(200).json({
            message: 'Registration successful',
            join_url: zoomData.join_url,
        });

        const mailchimpResponse = await fetch(`https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`, {
            method: 'POST',
            headers: {
                'Authorization': `apikey ${MAILCHIMP_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email_address: email,
                status_if_new: "subscribed",  // if already exists, update status to subscribed
                merge_fields: {
                    FNAME: firstName,
                    LNAME: lastName,
                    COMPANY: company,
                    JOBTITLE: jobTitle
                }
            })
        });

        if (!mailchimpResponse.ok && mailchimpResponse.status !== 400) {
            const errorText = await mailchimpResponse.text();
            const error = new Error(`Mailchimp API error: ${errorText}`);
            error.type = "mailchimp";
            error.text = errorText;
            throw error;
        }

    } catch (error) {
        console.log("error", error)
        console.error('Error At:', error?.type, error?.text);
        let errorInfo = error?.text;
        try {
            // Try to parse the error text if it's a JSON string
            if (typeof error?.text === 'string') {
                const parsedError = JSON.parse(error.text);
                errorInfo = parsedError.message || error.text;
            }
        } catch (e) {
            // If parsing fails, use the original error text
            errorInfo = error?.text;
        }
        res.status(500).send({
            message: 'Internal Server Error',
            info: errorInfo,
            errorAt: error?.type
        });
    }
});