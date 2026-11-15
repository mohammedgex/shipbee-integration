const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// نحتاج الـ rawBody للتحقق من HMAC
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ==========================================
// 1. الإعدادات - من Environment Variables فقط
// ==========================================
const SHIPBEE_API_KEY = process.env.SHIPBEE_API_KEY;
const SHIPBEE_BASE_URL = process.env.SHIPBEE_BASE_URL || 'https://api.staging.shipbee.io';
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ✅ بيانات Mofage الحقيقية
const SENDER = {
    name: 'Mofage',
    phone: '+97450002690',
    email: 'info@mofage.net',
    company: 'Mofage',
    address: {
        country: 'Qatar',
        city: 'Lusail',
        district: 'Fox Hills North',
        street: 'St 217',
        buildingNumber: '28',
        landmarks: 'Savoy Residences A',
        zone: 'Fox Hills'
    }
};

// ==========================================
// 2. نظام السجلات (KV اختياري + in-memory fallback)
// ==========================================
let kv = null;
try {
    const vk = require('@vercel/kv');
    if (vk && vk.kv) {
        kv = vk.kv;
        console.log('✅ يستخدم Vercel KV للسجلات الدائمة');
    }
} catch (e) {
    console.log('ℹ️ Vercel KV غير مثبّت — السجلات في الذاكرة فقط (تتصفر مع Cold Start)');
}

let inMemoryLogs = [];
const LOG_KEY = 'mofage_logs';
const MAX_LOGS = 200;

async function pushLog(entry) {
    const log = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        at: new Date().toISOString(),
        ...entry
    };

    if (kv) {
        try {
            await kv.lpush(LOG_KEY, JSON.stringify(log));
            await kv.ltrim(LOG_KEY, 0, MAX_LOGS - 1);
            return log;
        } catch (e) {
            console.error('KV push failed, falling back to memory:', e.message);
        }
    }

    inMemoryLogs.unshift(log);
    if (inMemoryLogs.length > MAX_LOGS) inMemoryLogs = inMemoryLogs.slice(0, MAX_LOGS);
    return log;
}

async function getLogs() {
    if (kv) {
        try {
            const raw = await kv.lrange(LOG_KEY, 0, -1);
            return raw.map(r => typeof r === 'string' ? JSON.parse(r) : r);
        } catch (e) {
            console.error('KV read failed:', e.message);
        }
    }
    return inMemoryLogs;
}

async function clearLogs() {
    if (kv) {
        try { await kv.del(LOG_KEY); } catch (e) { /* ignore */ }
    }
    inMemoryLogs = [];
}

async function isOrderAlreadyProcessed(orderId) {
    const all = await getLogs();
    return all.some(l =>
        l.orderId === orderId &&
        (l.status === 'success' || l.status === 'awaiting_payment')
    );
}

// ==========================================
// 3. HMAC Verification
// ==========================================
function verifyShopifyWebhook(req) {
    if (!WEBHOOK_SECRET) return true;
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (!hmac || !req.rawBody) return false;
    try {
        const digest = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(req.rawBody)
            .digest('base64');
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
    } catch {
        return false;
    }
}

// ==========================================
// 4. مساعدات
// ==========================================
function getPlannedShippingDate() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return `${t.toISOString().split('T')[0]}T10:00:00 GMT+03:00`;
}

function extractBuildingNumber(addr) {
    const text = `${addr.address1 || ''} ${addr.address2 || ''} ${addr.company || ''}`;
    const m = text.match(/\b(?:building|bldg|bld|no\.?|#)\s*(\d+[a-z]?)\b/i);
    return m ? m[1] : null;
}

// ==========================================
// 5. تحديث شوبيفاي (Fulfillment)
// ==========================================
async function fulfillShopifyOrder(orderId, trackingNumber, trackingCompany) {
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}`;
    const headers = {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
    };

    const foRes = await axios.get(
        `${base}/orders/${orderId}/fulfillment_orders.json`, { headers }
    );

    const orders = foRes.data.fulfillment_orders || [];
    const open = orders.find(o => o.status === 'open' || o.status === 'in_progress');

    if (!open) {
        throw new Error('لا يوجد Fulfillment Order مفتوح (ممكن يكون متشحن بالفعل)');
    }

    const ffRes = await axios.post(`${base}/fulfillments.json`, {
        fulfillment: {
            line_items_by_fulfillment_order: [{ fulfillment_order_id: open.id }],
            tracking_info: { number: trackingNumber, company: trackingCompany },
            notify_customer: true
        }
    }, { headers });

    return {
        fulfillmentId: ffRes.data.fulfillment.id,
        status: ffRes.data.fulfillment.status
    };
}

// ==========================================
// 6. إرسال ShipBee
// ==========================================
async function sendToShipBee(shopifyOrder) {
    if (!shopifyOrder.shipping_address) {
        throw new Error('لا يوجد عنوان شحن');
    }

    const addr = shopifyOrder.shipping_address;

    const missing = [];
    if (!addr.address1) missing.push('address1');
    if (!addr.city) missing.push('city');
    if (!addr.country) missing.push('country');
    if (!addr.phone && !shopifyOrder.phone) missing.push('phone');
    if (missing.length) {
        throw new Error(`عنوان الشحن ناقص الحقول: ${missing.join(', ')}`);
    }

    const payload = {
        serviceSubcategory: 'International',
        paymentMethod: 'MONTHLY_BILL',
        siteId: 'express-staging',
        senderName: SENDER.name,
        senderPhoneNumber: SENDER.phone,
        senderEmail: SENDER.email,
        senderCompanyName: SENDER.company,
        fromAddress: SENDER.address,
        shipment: {
            shippingCompany: 'DHL',
            weight: Math.max(0.1, (parseFloat(shopifyOrder.total_weight) || 100) / 1000),
            length: 40,
            width: 30,
            height: 20,
            itemCount: shopifyOrder.line_items?.length || 1,
            totalValue: parseFloat(shopifyOrder.subtotal_price) || 100,
            description: 'Headphones & Earbuds',
            incoTerm: 'DDU',
            purpose: 'Sale',
            plannedShippingDateAndTime: getPlannedShippingDate(),
            lineItems: (shopifyOrder.line_items || []).map((item, i) => ({
                number: i + 1,
                description: item.title?.substring(0, 50) || 'Item',
                price: parseFloat(item.price) || 10,
                quantity: { value: item.quantity || 1, unitOfMeasurement: 'PCS' },
                weight: { netValue: 0.3, grossValue: 0.5 },
                manufacturerCountry: 'China'
            }))
        },
        stops: [{
            sequence: 1,
            toAddress: {
                country: addr.country,
                city: addr.city,
                district: (addr.address2 || addr.address1).substring(0, 45),
                street: addr.address1.substring(0, 45),
                buildingNumber: extractBuildingNumber(addr) || 'N/A',
                landmarks: (addr.company || addr.address1).substring(0, 45),
                zipCode: addr.zip || '00000'
            },
            receiverName: `${addr.first_name || ''} ${addr.last_name || ''}`.trim() ||
                shopifyOrder.customer?.first_name ||
                'Guest',
            receiverPhoneNumber: addr.phone || shopifyOrder.phone,
            receiverEmail: shopifyOrder.email || shopifyOrder.customer?.email
        }]
    };

    const res = await axios.post(
        `${SHIPBEE_BASE_URL}/api/orders`,
        payload, {
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            }
        }
    );

    return { payload, response: res.data };
}

// ==========================================
// 7. الـ Webhook الرئيسي
// ==========================================
app.post('/webhooks/shopify/order-created', async(req, res) => {
    const startedAt = Date.now();
    const order = req.body;

    if (!verifyShopifyWebhook(req)) {
        await pushLog({
            type: 'webhook_rejected',
            reason: 'HMAC invalid',
            orderId: order?.id
        });
        return res.status(401).send('Unauthorized');
    }

    const baseLog = await pushLog({
        type: 'webhook_received',
        orderId: order.id,
        orderNumber: order.order_number,
        customer: order.email || order.customer?.email,
        country: order.shipping_address?.country,
        city: order.shipping_address?.city,
        total: order.total_price,
        currency: order.currency,
        shopifyPayload: order,
        status: 'processing'
    });

    try {
        if (await isOrderAlreadyProcessed(order.id)) {
            await pushLog({
                ...baseLog,
                id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                type: 'webhook_duplicate',
                status: 'duplicate_skipped'
            });
            return res.status(200).json({ success: true, message: 'Already processed' });
        }

        const { payload, response } = await sendToShipBee(order);

        await pushLog({
            type: 'shipbee_response',
            orderId: order.id,
            orderNumber: order.order_number,
            shipbeePayload: payload,
            shipbeeResponse: response,
            status: response.success ? 'shipbee_ok' : 'shipbee_failed'
        });

        if (!response.success) {
            return res.status(400).json(response);
        }

        const shipment = response.data?.shipment || {};
        const tracking = shipment.trackingNumber;

        if (!tracking) {
            await pushLog({
                type: 'awaiting_payment',
                orderId: order.id,
                orderNumber: order.order_number,
                paymentUrl: shipment.paymentUrl,
                status: 'awaiting_payment'
            });
            return res.status(200).json({
                success: true,
                tracking: null,
                paymentUrl: shipment.paymentUrl
            });
        }

        try {
            const ff = await fulfillShopifyOrder(
                order.id,
                tracking,
                shipment.shippingCompany || 'DHL'
            );

            await pushLog({
                type: 'success',
                orderId: order.id,
                orderNumber: order.order_number,
                customer: order.email || order.customer?.email,
                country: order.shipping_address?.country,
                total: order.total_price,
                currency: order.currency,
                tracking,
                trackingCompany: shipment.shippingCompany,
                fulfillmentId: ff.fulfillmentId,
                durationMs: Date.now() - startedAt,
                status: 'success'
            });

            return res.status(200).json({
                success: true,
                tracking,
                fulfillmentId: ff.fulfillmentId
            });
        } catch (ffErr) {
            await pushLog({
                type: 'shopify_update_failed',
                orderId: order.id,
                orderNumber: order.order_number,
                tracking,
                error: ffErr.message,
                status: 'shopify_update_failed'
            });
            return res.status(207).json({
                success: true,
                tracking,
                shopifyError: ffErr.message
            });
        }
    } catch (err) {
        await pushLog({
            type: 'error',
            orderId: order.id,
            orderNumber: order.order_number,
            error: err.message,
            status: 'error'
        });
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 8. لوحة المراقبة
// ==========================================
let DASHBOARD_HTML = '<h1>dashboard.html غير موجود</h1>';
try {
    DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
} catch (e) {
    console.error('لم يتم تحميل dashboard.html:', e.message);
}

app.get('/dashboard', (req, res) => res.send(DASHBOARD_HTML));
app.get('/api/logs', async(req, res) => res.json(await getLogs()));
app.delete('/api/logs', async(req, res) => {
    await clearLogs();
    res.json({ ok: true });
});
app.get('/', (req, res) => res.redirect('/dashboard'));

// ==========================================
// 9. تشغيل محلي فقط (Vercel يتجاهله)
// ==========================================
module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 http://localhost:${PORT}/dashboard`);
        console.log(`📡 POST /webhooks/shopify/order-created`);
        console.log(`🔐 HMAC: ${WEBHOOK_SECRET ? 'مفعّل ✓' : 'معطّل ⚠'}`);
        console.log(`📦 Shopify API: ${SHOPIFY_VERSION}`);
    });
}