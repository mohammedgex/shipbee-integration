const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==========================================
// 1. الإعدادات
// ==========================================
const SHIPBEE_API_KEY = process.env.SHIPBEE_API_KEY;
const SHIPBEE_BASE_URL = process.env.SHIPBEE_BASE_URL || 'https://api.staging.shipbee.io';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

const missing = ['SHIPBEE_API_KEY', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']
    .filter(k => !process.env[k]);
if (missing.length) {
    console.error(`[-] متغيرات بيئة ناقصة: ${missing.join(', ')}`);
    process.exit(1);
}

const processedOrders = new Set();

function getPlannedShippingDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    return `${dateStr}T10:00:00 GMT+03:00`;
}

// ==========================================
// 2. توكن شوبيفاي (بيتجدد تلقائياً)
// ==========================================
let cachedToken = { token: null, exp: 0 };

async function getShopifyToken() {
    if (cachedToken.token && Date.now() < cachedToken.exp - 60000) {
        return cachedToken.token;
    }
    const r = await axios.post(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
        new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: SHOPIFY_CLIENT_ID,
            client_secret: SHOPIFY_CLIENT_SECRET
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cachedToken = {
        token: r.data.access_token,
        exp: Date.now() + r.data.expires_in * 1000
    };
    console.log(`[i] تم تجديد توكن شوبيفاي. Scopes: ${r.data.scope}`);
    return cachedToken.token;
}

// ==========================================
// 3. دالة تحديث شوبيفاي
// ==========================================
async function fulfillShopifyOrder(shopifyOrderId, trackingNumber, trackingCompany) {
    try {
        console.log(`[>] جاري تحديث شوبيفاي للأوردر ${shopifyOrderId} برقم التتبع ${trackingNumber}...`);

        const token = await getShopifyToken();
        const headers = {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
        };

        const fulfillmentOrdersUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/fulfillment_orders.json`;
        const foResponse = await axios.get(fulfillmentOrdersUrl, { headers });
        const fulfillmentOrders = foResponse.data.fulfillment_orders || [];

        const openFO = fulfillmentOrders.find(fo => ['open', 'in_progress'].includes(fo.status));

        if (!openFO) {
            console.log(`[i] مفيش Fulfillment Order مفتوح للأوردر ${shopifyOrderId}. غالباً اتنفّذ قبل كده.`);
            return { success: true, skipped: true };
        }

        const fulfillmentUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/fulfillments.json`;
        const fulfillmentPayload = {
            fulfillment: {
                line_items_by_fulfillment_order: [{ fulfillment_order_id: openFO.id }],
                tracking_info: { number: trackingNumber, company: trackingCompany },
                notify_customer: true
            }
        };

        const fulfillmentResponse = await axios.post(fulfillmentUrl, fulfillmentPayload, { headers });
        const fulfillmentData = fulfillmentResponse.data.fulfillment;

        console.log(`[✓] تم تحديث شوبيفاي بنجاح! Fulfillment ID: ${fulfillmentData.id}`);
        return { success: true, skipped: false, fulfillmentId: fulfillmentData.id };

    } catch (error) {
        const errorDetails = error.response ? error.response.data : error.message;
        console.error('[-] فشل تحديث شوبيفاي:', JSON.stringify(errorDetails, null, 2));
        throw new Error(`فشل تحديث شوبيفاي: ${errorDetails && errorDetails.errors ? JSON.stringify(errorDetails.errors) : error.message}`);
    }
}

// ==========================================
// 4. معالجة الأوردر
// ==========================================
async function processOrder(shopifyOrder) {
    const orderRef = shopifyOrder.order_number || shopifyOrder.id;
    const shippingAddr = shopifyOrder.shipping_address;

    const street = (shippingAddr.address1 || '').substring(0, 45);
    const district = (shippingAddr.address2 || shippingAddr.province || shippingAddr.city || '').substring(0, 45);
    const landmarks = (shippingAddr.company || shippingAddr.address1 || '').substring(0, 45);

    const toAddress = {
        country: shippingAddr.country,
        city: shippingAddr.city,
        district: district,
        street: street,
        buildingNumber: '10',
        landmarks: landmarks
    };
    if (shippingAddr.zip) toAddress.zipCode = shippingAddr.zip;

    const shipbeePayload = {
        serviceSubcategory: 'International',
        paymentMethod: 'MONTHLY_BILL',
        siteId: 'express-staging',
        senderName: 'Doha Threads WLL',
        senderPhoneNumber: '+97455512345',
        senderEmail: 'info@my-shopify-store.com',
        senderCompanyName: 'My Shopify Store',
        fromAddress: {
            country: 'Qatar',
            city: 'Doha',
            district: 'West Bay',
            street: 'Corniche St',
            buildingNumber: '12',
            zone: 'Zone 61',
            landmarks: 'Near City Center Mall'
        },
        shipment: {
            shippingCompany: 'DHL',
            weight: Math.max(0.1, parseFloat(shopifyOrder.total_weight || 1000) / 1000),
            length: 40,
            width: 30,
            height: 20,
            itemCount: shopifyOrder.line_items ? shopifyOrder.line_items.length : 1,
            totalValue: parseFloat(shopifyOrder.total_price || 100),
            description: 'Headphones & Earbuds',
            incoTerm: 'DDU',
            purpose: 'Sale',
            plannedShippingDateAndTime: getPlannedShippingDate(),
            lineItems: shopifyOrder.line_items ? shopifyOrder.line_items.map((item, index) => ({
                number: index + 1,
                description: item.title ? item.title.substring(0, 50) : 'Item',
                price: parseFloat(item.price) || 10,
                quantity: { value: item.quantity || 1, unitOfMeasurement: 'PCS' },
                weight: { netValue: 0.3, grossValue: 0.5 },
                manufacturerCountry: 'China'
            })) : []
        },
        stops: [{
            sequence: 1,
            toAddress: toAddress,
            receiverName: `${shippingAddr.first_name || 'Guest'} ${shippingAddr.last_name || ''}`.trim(),
            receiverPhoneNumber: shippingAddr.phone || shopifyOrder.phone || '+971501234567',
            receiverEmail: shopifyOrder.email || 'customer@example.com'
        }]
    };

    console.log('[>] جاري إرسال الطلب إلى ShipBee...');

    let resData;
    try {
        const shipbeeResponse = await axios.post(`${SHIPBEE_BASE_URL}/api/orders`, shipbeePayload, {
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        resData = shipbeeResponse.data;
    } catch (error) {
        processedOrders.delete(shopifyOrder.id);
        console.error('[-] ShipBee Error:', error.response ? JSON.stringify(error.response.data) : error.message);
        return;
    }

    if (!resData.success) {
        processedOrders.delete(shopifyOrder.id);
        console.error('[-] ShipBee Error:', resData.message);
        return;
    }

    const shipbeeOrder = resData.data;
    const trackingNumber = shipbeeOrder.shipment ? shipbeeOrder.shipment.trackingNumber : null;
    const trackingCompany = shipbeeOrder.shipment ? shipbeeOrder.shipment.shippingCompany : 'DHL';

    console.log(`[✓] تم إنشاء الشحنة في ShipBee! رقم الطلب: ${shipbeeOrder.orderNo}`);

    if (!trackingNumber) {
        console.log('[-] تنبيه: لا يوجد Tracking Number بعد. الشحنة محتاجة دفع أولاً.');
        return;
    }

    console.log(`[✓] رقم التتبع: ${trackingNumber} | شركة الشحن: ${trackingCompany}`);

    try {
        const result = await fulfillShopifyOrder(shopifyOrder.id, trackingNumber, trackingCompany);
        if (!result.skipped) {
            console.log(`[✓] الأوردر #${orderRef} اكتمل بنجاح.`);
        }
    } catch (err) {
        console.error(`[-] الشحنة اتعملت في ShipBee لكن فشل تحديث شوبيفاي: ${err.message}`);
    }
}

// ==========================================
// 5. استقبال الـ Webhook (بدون تحقق HMAC)
// ==========================================
app.post('/webhooks/shopify/order-created', (req, res) => {
    const shopifyOrder = req.body;

    console.log(`\n=========================================`);
    console.log(`[+] استلام طلب جديد من شوبيفاي #${shopifyOrder.order_number || shopifyOrder.id}`);

    res.status(200).send('OK');

    if (!shopifyOrder.shipping_address) {
        console.log('[-] الطلب لا يحتوي على عنوان شحن، تم التغاضي عنه.');
        return;
    }

    if (processedOrders.has(shopifyOrder.id)) {
        console.log(`[i] الأوردر ${shopifyOrder.id} اتعالج قبل كده.`);
        return;
    }
    processedOrders.add(shopifyOrder.id);

    processOrder(shopifyOrder).catch(err => {
        console.error('[-] خطأ عام:', err.message);
    });
});

// Health Check
app.get('/', (req, res) => {
    res.send('ShipBee - Shopify Integration Middleware is Running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});