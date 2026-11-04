const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==========================================
// 1. الإعدادات
// ==========================================
const SHIPBEE_API_KEY = process.env.SHIPBEE_API_KEY || '6cl916m54wgm116spn12sz32fbhmx1';
const SHIPBEE_BASE_URL = process.env.SHIPBEE_BASE_URL || 'https://api.staging.shipbee.io';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'mofage-iq9btkui.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

if (!SHOPIFY_ACCESS_TOKEN) {
    console.error(`[-] متغير بيئة ناقص: SHOPIFY_ACCESS_TOKEN`);
    process.exit(1);
}

// ✅ منع تكرار معالجة نفس الأوردر
const processedOrders = new Set();

// دالة توليد تاريخ الشحن
function getPlannedShippingDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    return `${dateStr}T10:00:00 GMT+03:00`;
}

// ==========================================
// 2. دالة تحديث شوبيفاي (Fulfillment)
// ==========================================
async function fulfillShopifyOrder(shopifyOrderId, trackingNumber, trackingCompany) {
    try {
        console.log(`[>] جاري تحديث شوبيفاي للأوردر ${shopifyOrderId} برقم التتبع ${trackingNumber}...`);

        const headers = {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
        };

        // أ) جلب الـ fulfillment orders
        const fulfillmentOrdersUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/fulfillment_orders.json`;
        const foResponse = await axios.get(fulfillmentOrdersUrl, { headers });
        const fulfillmentOrders = foResponse.data.fulfillment_orders || [];

        // ✅ بنختار الـ Fulfillment Order اللي لسه مفتوح (عشان ميرميش إيرور لو الأوردر اتشحن قبل كده)
        const openFO = fulfillmentOrders.find(fo => ['open', 'in_progress'].includes(fo.status));

        if (!openFO) {
            console.log(`[i] مفيش Fulfillment Order مفتوح للأوردر ${shopifyOrderId}. يبدو أنه تم شحنه مسبقاً.`);
            return { success: true, skipped: true };
        }

        // ب) إنشاء الـ Fulfillment
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
        console.log(`[✓] رابط التتبع: ${fulfillmentData.tracking_url || 'غير متوفر'}`);

        return { success: true, skipped: false, fulfillmentId: fulfillmentData.id };

    } catch (error) {
        const errorDetails = error.response ? error.response.data : error.message;
        console.error('[-] فشل تحديث شوبيفاي:', JSON.stringify(errorDetails, null, 2));
        throw new Error(`فشل تحديث شوبيفاي: ${errorDetails && errorDetails.errors ? JSON.stringify(errorDetails.errors) : error.message}`);
    }
}

// ==========================================
// 3. دالة معالجة الأوردر (ShipBee ثم شوبيفاي)
// ==========================================
async function processOrder(shopifyOrder) {
    const orderRef = shopifyOrder.order_number || shopifyOrder.id;
    const shippingAddr = shopifyOrder.shipping_address;

    // قص العناوين لـ 45 حرف لـ DHL
    const street = (shippingAddr.address1 || "Street 1").substring(0, 45);
    const district = (shippingAddr.address2 || "District 1").substring(0, 45);
    const landmarks = (shippingAddr.company || shippingAddr.address1 || "Main Street").substring(0, 45);
    const zipCode = shippingAddr.zip || "00000";

    const shipbeePayload = {
        serviceSubcategory: "International",
        paymentMethod: "MONTHLY_BILL",
        siteId: "express-staging",

        senderName: "Doha Threads WLL",
        senderPhoneNumber: "+97455512345",
        senderEmail: "info@my-shopify-store.com",
        senderCompanyName: "My Shopify Store",
        fromAddress: {
            country: "Qatar",
            city: "Doha",
            district: "West Bay",
            street: "Corniche St",
            buildingNumber: "12",
            zone: "Zone 61",
            landmarks: "Near City Center Mall"
        },

        shipment: {
            shippingCompany: "DHL",
            weight: Math.max(0.1, parseFloat(shopifyOrder.total_weight || 1000) / 1000),
            length: 40,
            width: 30,
            height: 20,
            itemCount: shopifyOrder.line_items ? shopifyOrder.line_items.length : 1,
            totalValue: parseFloat(shopifyOrder.total_price || 100),
            description: "Headphones & Earbuds",
            incoTerm: "DDU",
            purpose: "Sale",
            plannedShippingDateAndTime: getPlannedShippingDate(),

            lineItems: shopifyOrder.line_items ? shopifyOrder.line_items.map((item, index) => ({
                number: index + 1,
                description: item.title ? item.title.substring(0, 50) : "Item",
                price: parseFloat(item.price) || 10,
                quantity: { value: item.quantity || 1, unitOfMeasurement: "PCS" },
                weight: { netValue: 0.3, grossValue: 0.5 },
                manufacturerCountry: "China"
            })) : []
        },

        stops: [{
            sequence: 1,
            toAddress: {
                country: shippingAddr.country || "United Arab Emirates",
                city: shippingAddr.city || "Dubai",
                district: district,
                street: street,
                buildingNumber: "10",
                landmarks: landmarks,
                zipCode: zipCode
            },
            receiverName: `${shippingAddr.first_name || 'Guest'} ${shippingAddr.last_name || ''}`.trim(),
            receiverPhoneNumber: shippingAddr.phone || "+971501234567",
            receiverEmail: shopifyOrder.email || "customer@example.com"
        }]
    };

    console.log('[>] جاري إرسال الطلب إلى ShipBee...');

    try {
        const shipbeeResponse = await axios.post(`${SHIPBEE_BASE_URL}/api/orders`, shipbeePayload, {
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        const resData = shipbeeResponse.data;

        if (!resData.success) {
            console.error('[-] ShipBee Error:', resData.message);
            processedOrders.delete(shopifyOrder.id); // مسح الأوردر عشان نقدر نعيد المحاولة
            return;
        }

        const shipbeeOrder = resData.data;
        const trackingNumber = shipbeeOrder.shipment ? shipbeeOrder.shipment.trackingNumber : null;
        const trackingCompany = shipbeeOrder.shipment ? shipbeeOrder.shipment.shippingCompany : 'DHL';
        const paymentUrl = shipbeeOrder.shipment ? shipbeeOrder.shipment.paymentUrl : null;

        console.log(`[✓] تم إنشاء الشحنة في ShipBee! رقم الطلب: ${shipbeeOrder.orderNo}`);

        if (!trackingNumber) {
            console.log('[-] تنبيه: لا يوجد Tracking Number. الشحنة محتاجة دفع أولاً.');
            if (paymentUrl) console.log(`[>] رابط الدفع: ${paymentUrl}`);
            return;
        }

        console.log(`[✓] رقم التتبع: ${trackingNumber} | شركة الشحن: ${trackingCompany}`);

        // تحديث شوبيفاي
        await fulfillShopifyOrder(shopifyOrder.id, trackingNumber, trackingCompany);

    } catch (error) {
        processedOrders.delete(shopifyOrder.id);
        console.error('[-] خطأ في ShipBee:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

// ==========================================
// 4. استقبال الـ Webhook
// ==========================================
app.post('/webhooks/shopify/order-created', (req, res) => {
    const shopifyOrder = req.body;

    console.log(`\n=========================================`);
    console.log(`[+] استلام طلب جديد من شوبيفاي #${shopifyOrder.order_number || shopifyOrder.id}`);

    // ✅ 1. نرد على شوبيفاي فوراً عشان Vercel ميعملش Timeout وشوبيفاي ميبعتش الطلب تاني
    res.status(200).send('OK');

    // 2. التأكد من وجود عنوان شحن
    if (!shopifyOrder.shipping_address) {
        console.log('[-] الطلب لا يحتوي على عنوان شحن، تم التغاضي عنه.');
        return;
    }

    // 3. منع التكرار
    if (processedOrders.has(shopifyOrder.id)) {
        console.log(`[i] الأوردر ${shopifyOrder.id} اتعالج قبل كده.`);
        return;
    }
    processedOrders.add(shopifyOrder.id);

    // 4. معالجة الأوردر في الخلفية
    processOrder(shopifyOrder).catch(err => {
        console.error('[-] خطأ غير متوقع:', err.message);
    });
});

// Health Check
app.get('/', (req, res) => {
    res.send('ShipBee - Shopify Integration Middleware is Running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 جاهز لاستقبال الطلبات على /webhooks/shopify/order-created`);
});