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
const PRODUCT_PACKAGING_RECORDS = require('./product-packaging.json');
const PRODUCT_DIMENSIONS_PATH = fs.existsSync(path.join(__dirname, 'product-dimensions.json')) ?
    './product-dimensions.json' : './product-packaging.json';
if (PRODUCT_DIMENSIONS_PATH === './product-packaging.json') {
    console.warn('[shopify-carrier-rates] product-dimensions.json is missing; using product-packaging.json');
}
const loadedProductDimensions = require(PRODUCT_DIMENSIONS_PATH);
const PRODUCT_DIMENSION_RECORDS = Array.isArray(loadedProductDimensions) ?
    loadedProductDimensions :
    (loadedProductDimensions && Array.isArray(loadedProductDimensions.products) ?
        loadedProductDimensions.products : []);
const VOLUMETRIC_DIVISOR = 5000;
const SHIPPING_COMPANY = 'DHL';
const CARRIER_RATE_CURRENCY = 'QAR';
const PLANNED_SHIPPING_DAYS_AHEAD = 3;

function getPlannedShippingDate() {
    const date = new Date(Date.now() + (3 * 60 * 60 * 1000));
    date.setUTCDate(date.getUTCDate() + PLANNED_SHIPPING_DAYS_AHEAD);
    return `${date.toISOString().slice(0, 10)}T10:00:00 GMT+03:00`;
}

if (!PRODUCT_DIMENSION_RECORDS.length) {
    throw new Error(`${PRODUCT_DIMENSIONS_PATH} must contain a non-empty array of product dimension records`);
}

function normalizeProductTitle(title) {
    return String(title || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s+default title$/, '');
}

function getProductNameSimilarity(left, right) {
    const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const currentRow = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
            currentRow[rightIndex] = Math.min(
                currentRow[rightIndex - 1] + 1,
                previousRow[rightIndex] + 1,
                previousRow[rightIndex - 1] + substitutionCost
            );
        }
        for (let index = 0; index < currentRow.length; index += 1) {
            previousRow[index] = currentRow[index];
        }
    }

    const editSimilarity = 1 - previousRow[right.length] / Math.max(left.length, right.length);
    const leftWords = new Set(left.split(' '));
    const rightWords = new Set(right.split(' '));
    const sharedWords = [...leftWords].filter(word => rightWords.has(word)).length;
    const wordSimilarity = (2 * sharedWords) / (leftWords.size + rightWords.size);
    return (editSimilarity * 0.65) + (wordSimilarity * 0.35);
}

function getFuzzyProductPackaging(name) {
    if (!name) return null;

    const bestMatchByPackage = new Map();
    for (const product of PRODUCT_PACKAGING_RECORDS) {
        const candidateName = normalizeProductTitle(product.name);
        const score = getProductNameSimilarity(name, candidateName);
        const packageKey = [
            product.length,
            product.width,
            product.height,
            product.weightKg
        ].join(':');
        const current = bestMatchByPackage.get(packageKey);
        if (!current || score > current.score) {
            bestMatchByPackage.set(packageKey, { product, score });
        }
    }

    const matches = [...bestMatchByPackage.values()].sort((left, right) => right.score - left.score);
    const best = matches[0];
    const secondBest = matches[1];
    if (!best || best.score < 0.82 || (secondBest && best.score - secondBest.score < 0.08)) {
        return null;
    }
    return best.product;
}

function createPackagingIndex(getKey) {
    const index = new Map();
    const ambiguous = new Set();

    for (const product of PRODUCT_PACKAGING_RECORDS) {
        const key = getKey(product);
        if (!key || ambiguous.has(key)) continue;

        const existing = index.get(key);
        if (!existing) {
            index.set(key, product);
        } else if (
            existing.length !== product.length ||
            existing.width !== product.width ||
            existing.height !== product.height ||
            existing.weightKg !== product.weightKg
        ) {
            index.delete(key);
            ambiguous.add(key);
        }
    }

    return index;
}

const PRODUCT_PACKAGING_BY_SKU = createPackagingIndex(product => product.sku);
const PRODUCT_PACKAGING_BY_NAME = createPackagingIndex(product => normalizeProductTitle(product.name));

function getProductPackaging(item) {
    const sku = String(item.sku || '').trim();
    const name = normalizeProductTitle(item.title);
    const packaging = PRODUCT_PACKAGING_BY_SKU.get(sku) ||
        PRODUCT_PACKAGING_BY_NAME.get(name) ||
        getFuzzyProductPackaging(name);
    if (!packaging) {
        const identifier = [sku && `SKU ${sku}`, item.title].filter(Boolean).join(' / ') || 'غير معروف';
        throw new Error(`تعذر مطابقة اسم المنتج بشكل فريد مع بيانات الأبعاد والوزن: ${identifier}`);
    }
    return packaging;
}

function createCarrierDimensionIndex(getKey) {
    const index = new Map();
    const ambiguous = new Set();
    for (const product of PRODUCT_DIMENSION_RECORDS) {
        const key = getKey(product);
        if (!key || ambiguous.has(key)) continue;
        const existing = index.get(key);
        if (!existing) {
            index.set(key, product);
        } else if (
            existing.length !== product.length ||
            existing.width !== product.width ||
            existing.height !== product.height ||
            existing.weightKg !== product.weightKg
        ) {
            index.delete(key);
            ambiguous.add(key);
        }
    }
    return index;
}

const CARRIER_DIMENSIONS_BY_SKU = createCarrierDimensionIndex(product =>
    String(product.sku || '').trim()
);
const CARRIER_DIMENSIONS_BY_NAME = createCarrierDimensionIndex(product =>
    normalizeProductTitle(product.name)
);

function findCarrierProductDimensions(item) {
    const sku = String(item.sku || '').trim();
    const name = normalizeProductTitle(item.name || item.title);
    const exactMatch = CARRIER_DIMENSIONS_BY_SKU.get(sku) ||
        CARRIER_DIMENSIONS_BY_NAME.get(name);
    if (exactMatch) return exactMatch;
    if (!name) return null;

    const matchesByPackage = new Map();
    for (const product of PRODUCT_DIMENSION_RECORDS) {
        const candidateName = normalizeProductTitle(product.name);
        if (!candidateName) continue;
        const score = getProductNameSimilarity(name, candidateName);
        const packageKey = [
            product.length,
            product.width,
            product.height,
            product.weightKg
        ].join(':');
        const match = matchesByPackage.get(packageKey);
        if (!match || score > match.score) matchesByPackage.set(packageKey, { product, score });
    }

    const matches = [...matchesByPackage.values()].sort((left, right) => right.score - left.score);
    if (!matches[0] || matches[0].score < 0.82 ||
        (matches[1] && matches[0].score - matches[1].score < 0.08)) {
        return null;
    }
    return matches[0].product;
}

function getCarrierItemWeightKg(item, productDimensions) {
    const grams = Number(item.grams);
    if (Number.isFinite(grams) && grams > 0) return grams / 1000;
    const weightKg = Number(productDimensions && productDimensions.weightKg);
    return Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 0;
}

function getEstimatedPackageDimensions(weightKg) {
    const side = Math.cbrt(weightKg * VOLUMETRIC_DIVISOR);
    return { length: side, width: side, height: side };
}

function calculateCarrierRates(rate) {
    if (!rate || typeof rate !== 'object' ||
        !rate.origin || typeof rate.origin !== 'object' ||
        !rate.destination || typeof rate.destination !== 'object' ||
        !Array.isArray(rate.items) || !rate.items.length ||
        !(rate.destination.country || rate.destination.country_code) ||
        String(rate.currency || '').toUpperCase() !== CARRIER_RATE_CURRENCY) {
        return [];
    }

    let actualWeightKg = 0;
    let totalVolumeCm3 = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    for (const item of rate.items) {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) return [];

        const productDimensions = findCarrierProductDimensions(item);
        const itemWeightKg = getCarrierItemWeightKg(item, productDimensions);
        const hasProductDimensions = productDimensions && [productDimensions.length, productDimensions.width, productDimensions.height]
            .every(value => Number.isFinite(Number(value)) && Number(value) > 0);
        if (!hasProductDimensions && itemWeightKg <= 0) return [];

        actualWeightKg += itemWeightKg * quantity;
        const dimensions = hasProductDimensions ? productDimensions :
            getEstimatedPackageDimensions(itemWeightKg);
        totalVolumeCm3 += dimensions.length * dimensions.width * dimensions.height * quantity;
        maxLength = Math.max(maxLength, dimensions.length);
        maxWidth = Math.max(maxWidth, dimensions.width);
        maxHeight = Math.max(maxHeight, dimensions.height);
    }

    if (actualWeightKg <= 0 && totalVolumeCm3 <= 0) return [];
    if (actualWeightKg <= 0) actualWeightKg = totalVolumeCm3 / VOLUMETRIC_DIVISOR;

    const length = Math.max(maxLength, totalVolumeCm3 / (maxWidth * maxHeight));
    const volumetricWeightKg = (length * maxWidth * maxHeight) / VOLUMETRIC_DIVISOR;
    const chargeableWeightKg = Math.max(actualWeightKg, volumetricWeightKg);
    if (!Number.isFinite(chargeableWeightKg) || chargeableWeightKg <= 0) return [];

    const minDeliveryDate = new Date();
    minDeliveryDate.setUTCDate(minDeliveryDate.getUTCDate() + 3);
    const maxDeliveryDate = new Date();
    maxDeliveryDate.setUTCDate(maxDeliveryDate.getUTCDate() + 7);
    const rates = [];

    rates.push({
        service_name: SHIPPING_COMPANY,
        service_code: 'DHL',
        total_price: Math.round((120 + (chargeableWeightKg * 35)) * 100),
        currency: CARRIER_RATE_CURRENCY,
        min_delivery_date: minDeliveryDate.toISOString(),
        max_delivery_date: maxDeliveryDate.toISOString()
    });

    return rates;
}

// ✅ بيانات Mofage الحقيقية
const SENDER = {
    name: 'Mofage Trading',
    phone: '+97450002690',
    email: 'info@mofage.net',
    company: 'MOFAGE',
    address: {
        country: 'Qatar',
        city: 'Doha',
        district: 'West Bay',
        street: 'Fox Hills North St 217',
        buildingNumber: '28',
        landmarks: 'Savoy Residences A, Lusail',
        zone: 'Zone 61'
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
    if (!WEBHOOK_SECRET) {
        return { valid: false, reason: 'SHOPIFY_WEBHOOK_SECRET غير مضبوط في إعدادات التطبيق' };
    }
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (!hmac) {
        return { valid: false, reason: 'Shopify لم يرسل ترويسة X-Shopify-Hmac-Sha256' };
    }
    if (!req.rawBody) {
        return { valid: false, reason: 'تعذر قراءة جسم Webhook الخام للتحقق من التوقيع' };
    }
    try {
        const digest = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(req.rawBody)
            .digest('base64');
        const received = Buffer.from(hmac);
        const expected = Buffer.from(digest);
        return received.length === expected.length &&
            crypto.timingSafeEqual(received, expected) ?
            { valid: true, reason: null } :
            { valid: false, reason: 'توقيع HMAC لا يطابق السر المضبوط؛ تحقق من تطابق Shopify و SHOPIFY_WEBHOOK_SECRET في Vercel' };
    } catch (error) {
        return { valid: false, reason: `تعذر التحقق من توقيع Webhook: ${error.message}` };
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
    return getProductPackaging(item).weightKg;
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
    const itemWeightKg = lineItems.reduce((total, item) => {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`كمية المنتج غير صالحة: ${item.title || 'منتج بدون اسم'}`);
        }
        return total + (getLineItemWeightKg(item) * quantity);
    }, 0);
    if (itemWeightKg <= 0) throw new Error('وزن الشحنة غير موجود أو غير صالح');
    return itemWeightKg;
}

function calculateChargeableWeight(actualWeightKg, lengthCm, widthCm, heightCm) {
    const volumetricWeightKg = (lengthCm * widthCm * heightCm) / VOLUMETRIC_DIVISOR;
    return Math.max(actualWeightKg, volumetricWeightKg);
}

function getOrderPackage(order) {
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (!lineItems.length) throw new Error('الطلب لا يحتوي على منتجات للشحن');

    let totalVolumeCm3 = 0;
    let lineItemsWeightKg = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    for (const item of lineItems) {
        const packaging = getProductPackaging(item);

        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`كمية المنتج غير صالحة: ${item.title || 'منتج بدون اسم'}`);
        }

        totalVolumeCm3 += packaging.length * packaging.width * packaging.height * quantity;
        lineItemsWeightKg += getLineItemWeightKg(item) * quantity;
        maxLength = Math.max(maxLength, packaging.length);
        maxWidth = Math.max(maxWidth, packaging.width);
        maxHeight = Math.max(maxHeight, packaging.height);
    }

    const isSingleUnit = lineItems.length === 1 && Number(lineItems[0].quantity) === 1;
    const width = maxWidth;
    const height = maxHeight;
    const length = isSingleUnit ? maxLength :
        Math.max(maxLength, Math.ceil((totalVolumeCm3 / (width * height)) * 10) / 10);
    const actualWeightKg = Math.max(lineItemsWeightKg, getOrderWeightKg(order));

    return {
        actualWeightKg,
        chargeableWeightKg: calculateChargeableWeight(actualWeightKg, length, width, height),
        length,
        width,
        height
    };
}

async function getShippingQuote(address, packageDetails) {
    if (!SHIPBEE_API_KEY) throw new Error('SHIPBEE_API_KEY غير مضبوط');

    const params = {
        serviceSubcategory: 'International',
        fromCountry: SENDER.address.country,
        fromCity: SENDER.address.city,
        toCountry: address.country,
        toCity: address.city,
        weight: packageDetails.chargeableWeightKg,
        length: packageDetails.length,
        width: packageDetails.width,
        height: packageDetails.height,
        incoterm: 'DDU',
        shippingCompany: SHIPPING_COMPANY,
        plannedShippingDate: getPlannedShippingDate().split('T')[0]
    };
    if (address.zip) params.toPostCode = address.zip;

    let response;
    try {
        response = await axios.get(`${SHIPBEE_BASE_URL}/api/pricing/calculate`, {
            params,
            headers: { 'x-api-key': SHIPBEE_API_KEY },
            timeout: 8000
        });
    } catch (error) {
        const requestError = new Error(describeAxiosError(error, 'ShipBee GET /api/pricing/calculate'));
        requestError.integrationDiagnostic = {
            serviceName: 'ShipBee DHL pricing',
            endpoint: '/api/pricing/calculate',
            httpStatus: error.response && error.response.status || null,
            requestId: error.response && error.response.headers &&
                (error.response.headers['x-request-id'] ||
                    error.response.headers['request-id'] ||
                    error.response.headers['x-correlation-id']) || null,
            request: params,
            responseData: error.response && error.response.data || null
        };
        throw requestError;
    }

    const days = Array.isArray(response.data) ? response.data :
        (response.data && Array.isArray(response.data.data) ? response.data.data : []);
    const today = new Date().toISOString().split('T')[0];
    const sortedDays = days
        .filter(day => day.date >= today)
        .sort((left, right) => left.date.localeCompare(right.date));
    const dhlQuotes = [];
    for (const day of sortedDays) {
        for (const carrier of day.carriers || []) {
            if (carrier.carrier !== SHIPPING_COMPANY) continue;
            const totalCost = Number(carrier.totalCost);
            if (Number.isFinite(totalCost) && totalCost > 0) {
                return { ...carrier, quotedDate: day.date };
            }
            dhlQuotes.push({ date: day.date, totalCost: carrier.totalCost });
        }
    }

    const reason = dhlQuotes.length ?
        `ShipBee أعاد سعر DHL غير صالح: ${JSON.stringify(dhlQuotes)}` :
        `ShipBee لم يُرجع عرض ${SHIPPING_COMPANY} صالحًا لهذا العنوان والوزن`;
    const quoteError = new Error(reason);
    quoteError.integrationDiagnostic = {
        serviceName: 'ShipBee DHL pricing',
        endpoint: '/api/pricing/calculate',
        request: params,
        responseData: response.data,
        invalidQuotes: dhlQuotes
    };
    throw quoteError;
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

function getShipBeeErrorCode(response) {
    if (!response || typeof response !== 'object') return null;
    const sources = [
        response,
        response.error,
        response.data,
        response.data && response.data.error
    ];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const code = source.errorCode || source.error_code || source.code;
        if (typeof code === 'string' || typeof code === 'number') return String(code);
    }
    return null;
}

function redactShipBeeDiagnostic(value, key) {
    if (key && /address|phone|email|customer|recipient|sender|token|secret|authorization/i.test(key)) {
        return '[redacted]';
    }
    if (Array.isArray(value)) {
        return value.map(item => redactShipBeeDiagnostic(item, ''));
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactShipBeeDiagnostic(childValue, childKey)
    ]));
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
    const lineItems = Array.isArray(shopifyOrder.line_items) ? shopifyOrder.line_items : [];
    if (!lineItems.length) throw new Error('الطلب لا يحتوي على منتجات للشحن');
    const packageDetails = getOrderPackage(shopifyOrder);

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
    let shippingQuote = null;
    let shippingQuoteError = null;
    let shippingQuoteDiagnostic = null;
    try {
        shippingQuote = await getShippingQuote(addr, packageDetails);
    } catch (error) {
        shippingQuoteError = error.message;
        shippingQuoteDiagnostic = error.integrationDiagnostic || null;
        console.warn('[shipbee-order] DHL quote unavailable; continuing with MONTHLY_BILL order', {
            orderId: shopifyOrder.id,
            orderNumber: shopifyOrder.order_number,
            error: shippingQuoteError,
            diagnostic: shippingQuoteDiagnostic
        });
    }

    const payload = {
        serviceSubcategory: 'International',
        paymentMethod: 'MONTHLY_BILL',
        senderName: SENDER.name,
        senderPhoneNumber: SENDER.phone,
        senderEmail: SENDER.email,
        senderCompanyName: SENDER.company,
        fromAddress: SENDER.address,
        shipment: {
            shippingCompany: SHIPPING_COMPANY,
            weight: packageDetails.chargeableWeightKg,
            length: packageDetails.length,
            width: packageDetails.width,
            height: packageDetails.height,
            itemCount: 1,
            totalValue: customsTotalValue,
            description: 'Home Décor Items',
            incoterm: 'DDU',
            purpose: 'Sale',
            plannedShippingDateAndTime: getPlannedShippingDate(),
            pickupRequested: false,
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
        const requestError = new Error(describeAxiosError(error, 'ShipBee POST /api/orders'));
        requestError.integrationDiagnostic = {
            serviceName: 'ShipBee order creation',
            endpoint: '/api/orders',
            httpStatus: error.response && error.response.status || null,
            requestId: error.response && error.response.headers &&
                (error.response.headers['x-request-id'] ||
                    error.response.headers['request-id'] ||
                    error.response.headers['x-correlation-id']) || null,
            request: payload,
            responseData: error.response && error.response.data || null,
            shippingQuoteError,
            shippingQuoteDiagnostic
        };
        throw requestError;
    }

    return {
        payload,
        response: res.data,
        packageDetails,
        shippingQuote,
        shippingQuoteError,
        shippingQuoteDiagnostic,
        shipbeeHttpStatus: res.status,
        shipbeeRequestId: res.headers['x-request-id'] ||
            res.headers['request-id'] ||
            res.headers['x-correlation-id'] ||
            null
    };
}

// ==========================================
// 7. الـ Webhook الرئيسي
// ==========================================
app.post('/api/shopify/calculate-shipping', (req, res) => {
    const startedAt = Date.now();
    try {
        const rate = req.body && req.body.rate;
        const rates = calculateCarrierRates(rate);
        const log = {
            itemCount: rate && Array.isArray(rate.items) ? rate.items.length : 0,
            rateCount: rates.length,
            currency: rate && rate.currency || null,
            destination: rate && rate.destination &&
                (rate.destination.country || rate.destination.country_code) || null,
            durationMs: Date.now() - startedAt
        };
        if (rates.length) {
            console.info('[shopify-carrier-rates] calculated', log);
        } else {
            console.warn('[shopify-carrier-rates] no applicable rates; check destination, QAR currency, item weights and dimensions', log);
        }
        return res.status(200).json({ rates });
    } catch (error) {
        console.error('[shopify-carrier-rates] calculation failed', {
            message: error.message,
            durationMs: Date.now() - startedAt
        });
        return res.status(200).json({ rates: [] });
    }
});

app.post('/webhooks/shopify/order-created', async (req, res) => {
    const startedAt = Date.now();
    const order = req.body;

    const verification = verifyShopifyWebhook(req);
    if (!verification.valid) {
        await pushLog({
            type: 'webhook_rejected',
            status: 'webhook_rejected',
            reason: verification.reason,
            orderId: order && order.id,
            orderNumber: order && order.order_number,
            shopifyWebhookId: req.get('X-Shopify-Webhook-Id') || null,
            shopifyTopic: req.get('X-Shopify-Topic') || null
        });
        return res.status(401).json({
            success: false,
            code: 'SHOPIFY_WEBHOOK_HMAC_INVALID',
            message: verification.reason
        });
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
        orderSummary: {
            customerName: [
                order.customer && order.customer.first_name || order.shipping_address && order.shipping_address.first_name,
                order.customer && order.customer.last_name || order.shipping_address && order.shipping_address.last_name
            ].filter(Boolean).join(' '),
            items: (Array.isArray(order.line_items) ? order.line_items : []).map(item => ({
                title: item.title || 'منتج بدون اسم',
                sku: item.sku || '',
                quantity: item.quantity,
                unitPrice: item.price,
                lineTotal: item.final_line_price || item.line_price || null
            })),
            shippingLines: (Array.isArray(order.shipping_lines) ? order.shipping_lines : []).map(line => ({
                title: line.title || '',
                price: line.price || null,
                currency: order.currency || ''
            }))
        },
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
                    previousShipment.shippingCompany || SHIPPING_COMPANY
                );
                await pushLog({
                    type: 'success',
                    orderId: order.id,
                    orderNumber: order.order_number,
                    customer: order.email || (order.customer && order.customer.email),
                    country: order.shipping_address && order.shipping_address.country,
                    tracking: previousShipment.trackingNumber,
                    trackingCompany: previousShipment.shippingCompany || SHIPPING_COMPANY,
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

        const {
            payload,
            response,
            packageDetails,
            shippingQuote,
            shippingQuoteError,
            shippingQuoteDiagnostic,
            shipbeeHttpStatus,
            shipbeeRequestId
        } = await sendToShipBee(order);

        await pushLog({
            type: 'shipbee_response',
            orderId: order.id,
            orderNumber: order.order_number,
            packageDetails,
            shippingQuote,
            shippingQuoteError,
            shippingQuoteDiagnostic,
            paymentMethod: payload.paymentMethod,
            shipbeeHttpStatus,
            shipbeeRequestId,
            shipbeeErrorCode: getShipBeeErrorCode(response),
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
            const integrationErrorCode = 'MONTHLY_BILL_TRACKING_NUMBER_MISSING';
            await pushLog({
                type: 'error',
                orderId: order.id,
                orderNumber: order.order_number,
                shipbeeOrderId: response.data && response.data.id,
                shipbeeOrderNo: response.data && response.data.orderNo,
                paymentMethod: payload.paymentMethod,
                carrier: shipment.shippingCompany || SHIPPING_COMPANY,
                shipbeeHttpStatus,
                shipbeeRequestId,
                shipbeeErrorCode: getShipBeeErrorCode(response),
                integrationErrorCode,
                shipbeeResponse: response,
                error: message,
                status: 'error'
            });
            console.error('[shipbee-order] Monthly billing order has no tracking number', {
                orderId: order.id,
                orderNumber: order.order_number,
                shipbeeOrderId: response.data && response.data.id,
                shipbeeOrderNo: response.data && response.data.orderNo,
                paymentMethod: payload.paymentMethod,
                httpStatus: shipbeeHttpStatus,
                requestId: shipbeeRequestId,
                errorCode: getShipBeeErrorCode(response),
                integrationErrorCode,
                response: redactShipBeeDiagnostic(response)
            });
            return res.status(502).json({
                success: false,
                message,
                code: integrationErrorCode,
                paymentMethod: payload.paymentMethod,
                shipbeeOrderId: response.data && response.data.id,
                shipbeeOrderNo: response.data && response.data.orderNo,
                shipbeeErrorCode: getShipBeeErrorCode(response),
                shipbeeResponse: response
            });
        }

        try {
            const ff = await fulfillShopifyOrder(
                order.id,
                tracking,
                shipment.shippingCompany || SHIPPING_COMPANY
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
            shipbeeHttpStatus: err.integrationDiagnostic && err.integrationDiagnostic.httpStatus,
            shipbeeRequestId: err.integrationDiagnostic && err.integrationDiagnostic.requestId,
            shipbeeResponse: err.integrationDiagnostic && err.integrationDiagnostic.responseData,
            shippingQuoteError: err.integrationDiagnostic && err.integrationDiagnostic.shippingQuoteError,
            shippingQuoteDiagnostic: err.integrationDiagnostic && err.integrationDiagnostic.shippingQuoteDiagnostic,
            integrationDiagnostic: err.integrationDiagnostic || null,
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
                `${SHIPBEE_BASE_URL}${endpoint}` : `${SHIPBEE_BASE_URL}/api/v1${endpoint}`,
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
app.get('/api/shopify/orders/:orderId/details', requireDashboardAuth, async (req, res) => {
    const orderId = String(req.params.orderId || '');
    if (!/^\d+$/.test(orderId)) {
        return res.status(400).json({ success: false, message: 'معرّف طلب Shopify غير صالح' });
    }
    if (!SHOPIFY_DOMAIN) {
        return res.status(503).json({ success: false, message: 'SHOPIFY_STORE_DOMAIN غير مضبوط' });
    }

    let response;
    try {
        const token = await getShopifyToken();
        response = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders/${orderId}.json`, {
            headers: { 'X-Shopify-Access-Token': token },
            params: {
                fields: [
                    'id', 'order_number', 'email', 'phone', 'total_price',
                    'current_subtotal_price', 'subtotal_price', 'currency',
                    'customer', 'shipping_address', 'shipping_lines', 'line_items'
                ].join(',')
            },
            timeout: 15000
        }
        );
    } catch (error) {
        const message = describeAxiosError(error, 'Shopify GET order details');
        return res.status(error.response ? 502 : 503).json({ success: false, message });
    }

    const order = response.data && response.data.order;
    if (!order) {
        return res.status(404).json({ success: false, message: 'لم يُرجع Shopify بيانات لهذا الطلب' });
    }

    let packageDetails = null;
    let packageError = null;
    let shippingQuote = null;
    let quoteError = null;
    let quoteDiagnostic = null;
    try {
        packageDetails = getOrderPackage(order);
        try {
            shippingQuote = await getShippingQuote(order.shipping_address, packageDetails);
        } catch (error) {
            quoteError = error.message;
            quoteDiagnostic = error.integrationDiagnostic || null;
        }
    } catch (error) {
        packageError = error.message;
    }

    const address = order.shipping_address || {};
    const customer = order.customer || {};
    return res.json({
        success: true,
        orderId: order.id,
        orderNumber: order.order_number,
        customerName: [
            customer.first_name || address.first_name,
            customer.last_name || address.last_name
        ].filter(Boolean).join(' '),
        total: order.total_price,
        currency: order.currency,
        city: address.city || '',
        country: address.country || '',
        items: (Array.isArray(order.line_items) ? order.line_items : []).map(item => ({
            title: item.title || 'منتج بدون اسم',
            sku: item.sku || '',
            quantity: item.quantity,
            unitPrice: item.price,
            lineTotal: item.final_line_price || item.line_price || null
        })),
        shippingLines: (Array.isArray(order.shipping_lines) ? order.shipping_lines : []).map(line => ({
            title: line.title || '',
            price: line.price || null,
            currency: order.currency || ''
        })),
        packageDetails,
        packageError,
        shippingQuote,
        quoteError,
        quoteDiagnostic
    });
});
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

app.use('/api/shopify/calculate-shipping', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('[shopify-carrier-rates] request parsing failed', {
        message: error.message
    });
    return res.status(200).json({ rates: [] });
});

// ==========================================
// 9. تشغيل محلي فقط (Vercel يتجاهله)
// ==========================================
module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 http://localhost:${PORT}/dashboard`);
        console.log(`📡 POST /webhooks/shopify/order-created`);
        console.log(`📦 POST /api/shopify/calculate-shipping`);
        console.log(`🔐 HMAC: ${WEBHOOK_SECRET ? 'مفعّل ✓' : 'غير مضبوط — سيتم رفض الويبهوكات ⚠'}`);
        console.log(`📦 Shopify API: ${SHOPIFY_VERSION}`);
    });
}