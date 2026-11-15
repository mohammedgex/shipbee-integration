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
const SHIPBEE_BASE_URL = (process.env.SHIPBEE_BASE_URL || 'https://api.staging.shipbee.io').replace(/\/+$/, '');
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const configuredCurrencyRates = JSON.parse(process.env.CURRENCY_TO_USD_RATES || '{}');

if (!configuredCurrencyRates || typeof configuredCurrencyRates !== 'object' || Array.isArray(configuredCurrencyRates)) {
    throw new Error('CURRENCY_TO_USD_RATES must be a JSON object');
}
for (const [currency, rate] of Object.entries(configuredCurrencyRates)) {
    if (!/^[A-Z]{3}$/i.test(currency) || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid CURRENCY_TO_USD_RATES entry for ${currency}`);
    }
}
const CURRENCY_TO_USD_RATES = Object.fromEntries(
    Object.entries(configuredCurrencyRates).map(([currency, rate]) => [currency.toUpperCase(), rate])
);

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
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

if (KV_URL && KV_TOKEN) {
    try {
        const vk = require('@vercel/kv');
        if (vk && vk.kv) {
            kv = vk.kv;
            console.log('✅ Vercel KV مفعّل — السجلات دائمة');
        }
    } catch (e) {
        console.log('⚠️ @vercel/kv مش مثبت — سجلات في الذاكرة');
    }
} else {
    console.log('ℹ️ KV غير مهيأ — سجلات في الذاكرة (تتصفر مع Cold Start)');
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
        try {
            await kv.del(LOG_KEY);
        } catch (e) {
            console.error('KV delete failed:', e.message);
            throw new Error('Failed to clear persistent logs');
        }
    }
    inMemoryLogs = [];
}

async function findExistingShipBeeOrder(orderId) {
    const all = await getLogs();
    const responseLog = all.find(log => {
        const data = log.shipbeeResponse && log.shipbeeResponse.data;
        return log.orderId === orderId &&
            log.type === 'shipbee_response' &&
            log.shipbeeResponse &&
            log.shipbeeResponse.success &&
            data &&
            data.id;
    });
    if (!responseLog) return null;

    return {
        responseLog,
        fulfilled: all.some(log => log.orderId === orderId && log.status === 'success')
    };
}

// ==========================================
// 3. HMAC Verification
// ==========================================
function verifyShopifyWebhook(req) {
    if (!WEBHOOK_SECRET) return false;
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
function toUsd(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`قيمة غير صالحة للتحويل من ${currency} إلى USD`);
    }

    const normalizedCurrency = String(currency || '').toUpperCase();
    const rate = normalizedCurrency === 'USD' ? 1 : CURRENCY_TO_USD_RATES[normalizedCurrency];
    if (!rate) {
        throw new Error(
            `لا يوجد سعر تحويل مضبوط للعملة ${normalizedCurrency} إلى USD في CURRENCY_TO_USD_RATES`
        );
    }

    return Math.round(amount * rate * 100) / 100;
}

function getLineItemWeightKg(item) {
    const grams = Number(item.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
        throw new Error(`وزن المنتج غير موجود أو غير صالح: ${item.title || 'منتج بدون اسم'}`);
    }
    return grams / 1000;
}

function getDiscountedUnitPrice(item) {
    const price = Number(item.price);
    const quantity = Number(item.quantity);
    const totalDiscount = Number(item.total_discount || 0);
    if (!Number.isFinite(price) || price < 0 ||
        !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(totalDiscount) || totalDiscount < 0) {
        throw new Error(`سعر أو كمية غير صالحة للمنتج: ${item.title || 'منتج بدون اسم'}`);
    }

    return price - (totalDiscount / quantity);
}

function getOrderWeightKg(order) {
    const grams = Number(order.total_weight);
    if (Number.isFinite(grams) && grams > 0) return grams / 1000;

    const lineItems = order.line_items || [];
    const itemGrams = lineItems.reduce((total, item) => {
        const weight = Number(item.grams);
        const quantity = Number(item.quantity);
        return total + (Number.isFinite(weight) && weight > 0 && Number.isFinite(quantity) && quantity > 0 ?
            weight * quantity : 0);
    }, 0);
    if (itemGrams <= 0) throw new Error('وزن الشحنة غير موجود أو غير صالح');
    return itemGrams / 1000;
}

async function getDhlQuote(address, weightKg) {
    if (!SHIPBEE_API_KEY) throw new Error('SHIPBEE_API_KEY غير مضبوط');

    const params = {
        serviceSubcategory: 'International',
        fromCountry: SENDER.address.country,
        fromCity: SENDER.address.city,
        toCountry: address.country,
        toCity: address.city,
        weight: weightKg,
        length: 40,
        width: 30,
        height: 20,
        incoterm: 'DDU',
        shippingCompany: 'DHL'
    };
    if (address.zip) params.toPostCode = address.zip;

    let response;
    try {
        response = await axios.get(`${SHIPBEE_BASE_URL}/api/pricing/calculate`, {
            params,
            headers: { 'x-api-key': SHIPBEE_API_KEY }
        });
    } catch (error) {
        throw new Error(describeAxiosError(error, 'ShipBee GET /api/pricing/calculate'));
    }

    const days = Array.isArray(response.data) ? response.data :
        (response.data && Array.isArray(response.data.data) ? response.data.data : []);
    for (const day of days) {
        const dhl = (day.carriers || []).find(carrier =>
            carrier.carrier === 'DHL' &&
            carrier.totalCost !== null &&
            Number.isFinite(Number(carrier.totalCost))
        );
        if (dhl && day.date) return day.date;
    }

    throw new Error('ShipBee لم يُرجع عرض DHL صالحًا لهذا العنوان والوزن');
}

function extractBuildingNumber(addr) {
    const text = `${addr.address1 || ''} ${addr.address2 || ''} ${addr.company || ''}`;
    const m = text.match(/\b(?:building|bldg|bld|no\.?|#)\s*(\d+[a-z]?)\b/i);
    return m ? m[1] : null;
}

// ==========================================
// دالة جلب توكن جديد من Shopify
// ==========================================
let cachedToken = process.env.SHOPIFY_ACCESS_TOKEN;
let tokenExpiresAt = 0; // 0 = استخدم الـ env var مباشرة

async function getShopifyToken(forceRefresh = false) {
    // لو الـ token الحالي لسه صالح، رجّعه
    if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    // لو مفيش client credentials، استخدم الـ env token زي الأول
    if (!clientId || !clientSecret) {
        if (cachedToken) return cachedToken;
        throw new Error('SHOPIFY_ACCESS_TOKEN أو SHOPIFY_CLIENT_ID/SECRET غير موجودين');
    }

    try {
        const res = await axios.post(
            'https://' + SHOPIFY_DOMAIN + '/admin/oauth/access_token',
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret
            }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        cachedToken = res.data.access_token;
        // نجدد قبل الانتهاء بساعة
        tokenExpiresAt = Date.now() + ((res.data.expires_in - 3600) * 1000);
        console.log('🔄 تم تجديد Shopify token تلقائياً، صالح حتى ' + new Date(tokenExpiresAt).toISOString());
        return cachedToken;
    } catch (e) {
        console.error('فشل تجديد التوكن:', e.response ? e.response.data : e.message);
        // لو فشل، استخدم الـ cached لو موجود
        if (cachedToken) return cachedToken;
        throw new Error('فشل الحصول على Shopify token: ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    }
}

// ==========================================
// تحديث Shopify (بالتجديد التلقائي)
// ==========================================
async function fulfillShopifyOrder(orderId, trackingNumber, trackingCompany) {
    const base = 'https://' + SHOPIFY_DOMAIN + '/admin/api/' + SHOPIFY_VERSION;

    async function callShopify(method, url, data) {
        const token = await getShopifyToken();
        const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
        try {
            return method === 'GET' ?
                await axios.get(url, { headers }) :
                await axios.post(url, data, { headers });
        } catch (e) {
            // لو 401 (token منتهي)، جدد تلقائياً وأعد المحاولة مرة واحدة
            if (e.response && e.response.status === 401) {
                console.log('⚠️ Shopify token expired — جاري التجديد...');
                const freshToken = await getShopifyToken(true);
                headers['X-Shopify-Access-Token'] = freshToken;
                return method === 'GET' ?
                    await axios.get(url, { headers }) :
                    await axios.post(url, data, { headers });
            }
            throw e;
        }
    }

    let foRes;
    try {
        foRes = await callShopify('GET', base + '/orders/' + orderId + '/fulfillment_orders.json');
    } catch (e) {
        throw new Error(describeAxiosError(e, 'Shopify GET fulfillment_orders'));
    }

    const orders = foRes.data.fulfillment_orders || [];
    const open = orders.find(o => o.status === 'open' || o.status === 'in_progress');
    if (!open) throw new Error('[Shopify] لا يوجد Fulfillment Order مفتوح');

    let ffRes;
    try {
        ffRes = await callShopify('POST', base + '/fulfillments.json', {
            fulfillment: {
                line_items_by_fulfillment_order: [{ fulfillment_order_id: open.id }],
                tracking_info: { number: trackingNumber, company: trackingCompany },
                notify_customer: true
            }
        });
    } catch (e) {
        throw new Error(describeAxiosError(e, 'Shopify POST fulfillments'));
    }

    return { fulfillmentId: ffRes.data.fulfillment.id, status: ffRes.data.fulfillment.status };
}

function describeAxiosError(error, serviceName) {
    if (!error.response) {
        return `[${serviceName}] فشل الاتصال: ${error.message}`;
    }
    const { status, statusText, data } = error.response;
    let bodyStr;
    try {
        bodyStr = typeof data === 'string' ? data : (JSON.stringify(data) || String(data));
    } catch {
        bodyStr = String(data);
    }
    return `[${serviceName}] HTTP ${status} ${statusText || ''} — ${bodyStr.substring(0, 400)}`;
}

// ==========================================
// 6. إرسال ShipBee
// ==========================================
async function sendToShipBee(shopifyOrder) {
    if (!shopifyOrder.shipping_address) {
        throw new Error('لا يوجد عنوان شحن');
    }

    const addr = shopifyOrder.shipping_address;
    const currency = shopifyOrder.currency;
    const weightKg = getOrderWeightKg(shopifyOrder);
    const lineItems = Array.isArray(shopifyOrder.line_items) ? shopifyOrder.line_items : [];
    if (!lineItems.length) throw new Error('الطلب لا يحتوي على منتجات للشحن');

    const missing = [];
    if (!addr.address1) missing.push('address1');
    if (!addr.city) missing.push('city');
    if (!addr.country) missing.push('country');
    if (!addr.phone && !shopifyOrder.phone) missing.push('phone');
    if (missing.length) {
        throw new Error(`عنوان الشحن ناقص الحقول: ${missing.join(', ')}`);
    }

    const customsTotalValue = toUsd(
        shopifyOrder.current_subtotal_price || shopifyOrder.subtotal_price,
        currency
    );
    const customsLineItems = lineItems.map((item, i) => ({
        number: i + 1,
        description: (item.title && item.title.substring(0, 50)) || 'Item',
        price: toUsd(getDiscountedUnitPrice(item), currency),
        quantity: { value: item.quantity || 1, unitOfMeasurement: 'PCS' },
        weight: {
            netValue: getLineItemWeightKg(item),
            grossValue: getLineItemWeightKg(item)
        },
        manufacturerCountry: 'China'
    }));
    const quoteDate = await getDhlQuote(addr, weightKg);
    const payload = {
        serviceSubcategory: 'International',
        paymentMethod: 'MONTHLY_BILL',
        senderName: SENDER.name,
        senderPhoneNumber: SENDER.phone,
        senderEmail: SENDER.email,
        senderCompanyName: SENDER.company,
        fromAddress: SENDER.address,
        shipment: {
            shippingCompany: 'DHL',
            weight: weightKg,
            length: 40,
            width: 30,
            height: 20,
            itemCount: 1,
            totalValue: customsTotalValue,
            description: 'Headphones & Earbuds',
            incoterm: 'DDU',
            purpose: 'commercial',
            plannedShippingDateAndTime: `${quoteDate}T10:00:00 GMT+03:00`,
            lineItems: customsLineItems
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
                zipCode: addr.zip || undefined
            },
            receiverName: `${addr.first_name || ''} ${addr.last_name || ''}`.trim() ||
                (shopifyOrder.customer && shopifyOrder.customer.first_name) ||
                'Guest',
            receiverPhoneNumber: addr.phone || shopifyOrder.phone,
            receiverEmail: shopifyOrder.email || (shopifyOrder.customer && shopifyOrder.customer.email)
        }]
    };

    let res;
    try {
        res = await axios.post(
            `${SHIPBEE_BASE_URL}/api/orders`,
            payload, {
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            }
        }
        );
    } catch (error) {
        throw new Error(describeAxiosError(error, 'ShipBee POST /api/orders'));
    }

    return { payload, response: res.data };
}

// ==========================================
// 7. الـ Webhook الرئيسي
// ==========================================
app.post('/webhooks/shopify/order-created', async (req, res) => {
    const startedAt = Date.now();
    const order = req.body;

    if (!verifyShopifyWebhook(req)) {
        await pushLog({
            type: 'webhook_rejected',
            reason: 'HMAC invalid',
            orderId: order && order.id
        });
        return res.status(401).send('Unauthorized');
    }

    if (!order || typeof order !== 'object' || !order.id) {
        return res.status(400).send('Invalid Shopify order payload');
    }

    const baseLog = await pushLog({
        type: 'webhook_received',
        orderId: order.id,
        orderNumber: order.order_number,
        customer: order.email || (order.customer && order.customer.email),
        country: order.shipping_address && order.shipping_address.country,
        city: order.shipping_address && order.shipping_address.city,
        total: order.total_price,
        currency: order.currency,
        status: 'processing'
    });

    try {
        const previousShipBeeOrder = await findExistingShipBeeOrder(order.id);
        if (previousShipBeeOrder) {
            await pushLog({
                ...baseLog,
                id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                type: 'webhook_duplicate',
                status: 'duplicate_skipped'
            });
            if (previousShipBeeOrder.fulfilled) {
                return res.status(200).json({ success: true, message: 'Already fulfilled' });
            }

            const previousData = previousShipBeeOrder.responseLog.shipbeeResponse.data;
            const previousShipment = previousData.shipment || {};
            if (!previousShipment.trackingNumber) {
                return res.status(200).json({ success: true, message: 'ShipBee order already created' });
            }

            try {
                const ff = await fulfillShopifyOrder(
                    order.id,
                    previousShipment.trackingNumber,
                    previousShipment.shippingCompany || 'DHL'
                );
                await pushLog({
                    type: 'success',
                    orderId: order.id,
                    orderNumber: order.order_number,
                    customer: order.email || (order.customer && order.customer.email),
                    country: order.shipping_address && order.shipping_address.country,
                    tracking: previousShipment.trackingNumber,
                    trackingCompany: previousShipment.shippingCompany || 'DHL',
                    fulfillmentId: ff.fulfillmentId,
                    durationMs: Date.now() - startedAt,
                    status: 'success'
                });
                return res.status(200).json({
                    success: true,
                    tracking: previousShipment.trackingNumber,
                    fulfillmentId: ff.fulfillmentId
                });
            } catch (ffErr) {
                await pushLog({
                    type: 'shopify_update_failed',
                    orderId: order.id,
                    orderNumber: order.order_number,
                    tracking: previousShipment.trackingNumber,
                    error: ffErr.message,
                    status: 'shopify_update_failed'
                });
                return res.status(207).json({
                    success: true,
                    tracking: previousShipment.trackingNumber,
                    shopifyError: ffErr.message
                });
            }
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

        const shipment = (response.data && response.data.shipment) || {};
        const tracking = shipment.trackingNumber;

        if (!tracking) {
            const message = 'ShipBee did not return a tracking number for a MONTHLY_BILL shipment';
            await pushLog({
                type: 'error',
                orderId: order.id,
                orderNumber: order.order_number,
                shipbeeOrderId: response.data && response.data.id,
                shipbeeOrderNo: response.data && response.data.orderNo,
                error: message,
                status: 'error'
            });
            return res.status(502).json({ success: false, message });
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
                customer: order.email || (order.customer && order.customer.email),
                country: order.shipping_address && order.shipping_address.country,
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

function safeStringEqual(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requireDashboardAuth(req, res, next) {
    if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
        return res.status(503).send('Dashboard disabled: configure DASHBOARD_USERNAME and DASHBOARD_PASSWORD');
    }

    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (match) {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator >= 0) {
            const username = decoded.slice(0, separator);
            const password = decoded.slice(separator + 1);
            const usernameMatches = safeStringEqual(username, DASHBOARD_USERNAME);
            const passwordMatches = safeStringEqual(password, DASHBOARD_PASSWORD);
            if (usernameMatches && passwordMatches) {
                res.set('Cache-Control', 'no-store');
                return next();
            }
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="ShipBee dashboard"');
    return res.status(401).send('Authentication required');
}

async function requestShipBee(method, endpoint, params, data) {
    if (!SHIPBEE_API_KEY) {
        const error = new Error('SHIPBEE_API_KEY غير مضبوط');
        error.status = 503;
        throw error;
    }

    try {
        const response = await axios({
            method,
            url: endpoint.startsWith('/api/') ?
                `${SHIPBEE_BASE_URL}${endpoint}` :
                `${SHIPBEE_BASE_URL}/api/v1${endpoint}`,
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            },
            params,
            data,
            timeout: 20000
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            error.status = error.response.status;
            error.responseData = error.response.data;
        } else {
            error.status = 502;
        }
        throw error;
    }
}

async function handleShipBeeDashboardRequest(res, request) {
    try {
        return res.json(await request());
    } catch (error) {
        console.error('ShipBee dashboard request failed:', error.message);
        return res.status(error.status || 502).json(
            error.responseData || { success: false, message: error.message }
        );
    }
}

function isIsoDate(value) {
    return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

app.get('/api/shipbee/report', requireDashboardAuth, (req, res) => {
    const { startDate, endDate } = req.query;
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
        return res.status(400).json({ success: false, message: 'startDate و endDate مطلوبان بصيغة YYYY-MM-DD' });
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('GET', '/orders/report', { startDate, endDate })
    );
});

app.get('/api/shipbee/status', requireDashboardAuth, (req, res) => {
    const { orderNo, orderId } = req.query;
    if (!orderNo && !orderId) {
        return res.status(400).json({ success: false, message: 'أدخل orderNo أو orderId' });
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('GET', '/orders/view-order-status', { orderNo, orderId })
    );
});

app.get('/api/shipbee/tracking', requireDashboardAuth, (req, res) => {
    const { orderNo, orderId, trackingNumber, awb } = req.query;
    if (!orderNo && !orderId && !trackingNumber && !awb) {
        return res.status(400).json({
            success: false,
            message: 'أدخل رقم طلب ShipBee أو رقم التتبع أو AWB'
        });
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('GET', '/orders/track-shipment', {
            orderNo,
            orderId,
            trackingNumber,
            awb,
            refresh: req.query.refresh === 'true'
        })
    );
});

app.get('/api/shipbee/addresses', requireDashboardAuth, (req, res) =>
    handleShipBeeDashboardRequest(res, () => requestShipBee('GET', '/addresses'))
);

app.get('/api/shipbee/webhooks', requireDashboardAuth, (req, res) =>
    handleShipBeeDashboardRequest(res, () => requestShipBee('GET', '/webhooks'))
);

app.post('/api/shipbee/webhooks', requireDashboardAuth, (req, res) => {
    const { url, type } = req.body || {};
    let callbackUrl;
    try {
        callbackUrl = new URL(url);
    } catch {
        return res.status(400).json({ success: false, message: 'عنوان Webhook غير صالح' });
    }
    if (callbackUrl.protocol !== 'https:' || callbackUrl.username || callbackUrl.password) {
        return res.status(400).json({ success: false, message: 'Webhook يجب أن يستخدم HTTPS' });
    }
    if (type !== 'ORDER_STATUS_UPDATE') {
        return res.status(400).json({ success: false, message: 'نوع Webhook غير مدعوم' });
    }
    if (req.body.confirm !== `REGISTER ${type}`) {
        return res.status(400).json({ success: false, message: `أكد العملية بكتابة REGISTER ${type}` });
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('POST', '/webhooks/register', undefined, { url: callbackUrl.href, type })
    );
});

app.delete('/api/shipbee/webhooks', requireDashboardAuth, (req, res) => {
    const { type, url, confirm } = req.body || {};
    if (type !== 'ORDER_STATUS_UPDATE') {
        return res.status(400).json({ success: false, message: 'نوع Webhook غير مدعوم' });
    }
    if (url !== undefined && typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'عنوان Webhook غير صالح' });
    }
    const normalizedUrl = url && url.trim();
    if (normalizedUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(normalizedUrl);
        } catch {
            return res.status(400).json({ success: false, message: 'عنوان Webhook غير صالح' });
        }
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
            return res.status(400).json({ success: false, message: 'Webhook يجب أن يستخدم HTTPS' });
        }
    }
    const confirmation = `DELETE ${type} ${normalizedUrl || 'ALL'}`;
    if (confirm !== confirmation) {
        return res.status(400).json({ success: false, message: `أكد العملية بكتابة ${confirmation}` });
    }
    const data = { type };
    if (normalizedUrl) data.url = normalizedUrl;
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('DELETE', '/webhooks', undefined, data)
    );
});

app.get('/api/shipbee/pricing', requireDashboardAuth, (req, res) => {
    const required = ['fromCountry', 'toCountry', 'fromCity', 'toCity', 'weight'];
    const missing = required.filter(key => !req.query[key]);
    if (missing.length) {
        return res.status(400).json({ success: false, message: `حقول مطلوبة: ${missing.join(', ')}` });
    }
    const numericFields = ['weight', 'length', 'width', 'height'];
    for (const field of numericFields) {
        if (req.query[field] !== undefined &&
            (!Number.isFinite(Number(req.query[field])) || Number(req.query[field]) <= 0)) {
            return res.status(400).json({ success: false, message: `${field} يجب أن يكون رقمًا أكبر من صفر` });
        }
    }
    const allowedParams = [
        'fromCountry', 'toCountry', 'fromCity', 'toCity', 'weight',
        'length', 'width', 'height', 'fromPostCode', 'toPostCode',
        'toDistrict', 'isDocument', 'isDangerous', 'arabPost', 'incoterm',
        'shippingCompany', 'plannedShippingDate', 'packages'
    ];
    const params = { serviceSubcategory: 'International' };
    for (const field of allowedParams) {
        if (req.query[field] !== undefined) params[field] = req.query[field];
    }
    if (params.incoterm && !['DDU', 'DDP'].includes(String(params.incoterm).toUpperCase())) {
        return res.status(400).json({ success: false, message: 'incoterm يجب أن يكون DDU أو DDP' });
    }
    if (params.incoterm) params.incoterm = String(params.incoterm).toUpperCase();
    if (params.isDocument !== undefined && !['true', 'false'].includes(String(params.isDocument))) {
        return res.status(400).json({ success: false, message: 'isDocument يجب أن يكون true أو false' });
    }
    if (params.isDangerous !== undefined && !['true', 'false'].includes(String(params.isDangerous))) {
        return res.status(400).json({ success: false, message: 'isDangerous يجب أن يكون true أو false' });
    }
    if (params.packages !== undefined) {
        try {
            const packages = JSON.parse(params.packages);
            if (!Array.isArray(packages) || packages.length < 1 || packages.length > 5 ||
                packages.some(box => ['weight', 'length', 'width', 'height'].some(field =>
                    !Number.isFinite(Number(box[field])) || Number(box[field]) <= 0
                ))) {
                throw new Error('invalid package dimensions');
            }
            params.packages = JSON.stringify(packages);
        } catch {
            return res.status(400).json({
                success: false,
                message: 'packages يجب أن تكون JSON array من 1 إلى 5 صناديق بأوزان وأبعاد موجبة'
            });
        }
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('GET', '/pricing/calculate', params)
    );
});

app.get('/api/shipbee/countries', requireDashboardAuth, (req, res) =>
    handleShipBeeDashboardRequest(res, () => requestShipBee('GET', '/api/countries'))
);

app.get('/api/shipbee/shipment-descriptions', requireDashboardAuth, (req, res) =>
    handleShipBeeDashboardRequest(res, () => requestShipBee('GET', '/api/shipment-descriptions'))
);

app.post('/api/shipbee/cancel', requireDashboardAuth, (req, res) => {
    const { orderNo, confirm } = req.body || {};
    if (!/^\d+$/.test(String(orderNo || ''))) {
        return res.status(400).json({ success: false, message: 'orderNo يجب أن يكون رقمًا صحيحًا' });
    }
    if (confirm !== `CANCEL ${orderNo}`) {
        return res.status(400).json({ success: false, message: `أكد الإلغاء بكتابة CANCEL ${orderNo}` });
    }
    return handleShipBeeDashboardRequest(
        res,
        () => requestShipBee('POST', '/orders/cancel', { orderNo: Number(orderNo) })
    );
});

app.get('/dashboard', requireDashboardAuth, (req, res) => res.send(DASHBOARD_HTML));
app.get('/api/logs', requireDashboardAuth, async (req, res) => res.json(await getLogs()));
app.delete('/api/logs', requireDashboardAuth, async (req, res) => {
    await clearLogs();
    res.json({ ok: true });
});
app.get('/api/shipbee/config', requireDashboardAuth, (req, res) => {
    let environment = 'custom';
    try {
        const host = new URL(SHIPBEE_BASE_URL).hostname;
        if (host === 'api.staging.shipbee.io') environment = 'staging';
        else if (host === 'api.shipbee.io') environment = 'production';
    } catch (error) {
        console.error('Invalid SHIPBEE_BASE_URL:', error.message);
    }
    res.json({
        environment,
        apiKeyConfigured: Boolean(SHIPBEE_API_KEY)
    });
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
        console.log(`🔐 HMAC: ${WEBHOOK_SECRET ? 'مفعّل ✓' : 'غير مضبوط — سيتم رفض الويبهوكات ⚠'}`);
        console.log(`📦 Shopify API: ${SHOPIFY_VERSION}`);
    });
}