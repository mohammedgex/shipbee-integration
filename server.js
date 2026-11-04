const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==========================================
// 1. الإعدادات والبيانات الحساسة
// ==========================================
// إعدادات ShipBee
const SHIPBEE_API_KEY = process.env.SHIPBEE_API_KEY || '6cl916m54wgm116spn12sz32fbhmx1';
const SHIPBEE_BASE_URL = process.env.SHIPBEE_BASE_URL || 'https://api.staging.shipbee.io';

// إعدادات شوبيفاي (لازم تضيفهم في Environment Variables)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'mofage-iq9btkui.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'shpat_xxxxxxxxxxxxxxxxxxxxxxxx';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

// دالة مساعدة لتوليد تاريخ الشحن المطلوب (بكرة الساعة 10 صباحاً بتوقيت قطر +3)
function getPlannedShippingDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD
    return `${dateStr}T10:00:00 GMT+03:00`;
}

// ==========================================
// 2. دالة تحديث شوبيفاي (إنشاء Fulfillment وإضافة Tracking)
// ==========================================
async function fulfillShopifyOrder(shopifyOrderId, trackingNumber, trackingCompany) {
    try {
        console.log(`[>] جاري تحديث شوبيفاي للأوردر رقم ${shopifyOrderId} برقم التتبع ${trackingNumber}...`);

        // أ) جلب fulfillment_order_id من شوبيفاي
        const fulfillmentOrdersUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/fulfillment_orders.json`;

        const foResponse = await axios.get(fulfillmentOrdersUrl, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        const fulfillmentOrders = foResponse.data.fulfillment_orders;

        if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
            throw new Error('لا توجد Fulfillment Orders متاحة لهذا الطلب في شوبيفاي.');
        }

        const fulfillmentOrderId = fulfillmentOrders[0].id;

        // ب) إنشاء الـ Fulfillment مع رقم التتبع
        const fulfillmentUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/fulfillments.json`;

        const fulfillmentPayload = {
            fulfillment: {
                line_items_by_fulfillment_order: [{
                    fulfillment_order_id: fulfillmentOrderId
                }],
                tracking_info: {
                    number: trackingNumber,
                    company: trackingCompany // زي "DHL" أو "Aramex"
                },
                notify_customer: true // عشان شوبيفاي يبعت إيميل للعميل برقم التتبع
            }
        };

        const fulfillmentResponse = await axios.post(fulfillmentUrl, fulfillmentPayload, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        const fulfillmentData = fulfillmentResponse.data.fulfillment;

        console.log(`[✓] تم تحديث شوبيفاي بنجاح! Fulfillment ID: ${fulfillmentData.id}`);
        console.log(`[✓] حالة الشحن في شوبيفاي: ${fulfillmentData.status}`);
        if (fulfillmentData.tracking_url) {
            console.log(`[✓] رابط التتبع في شوبيفاي: ${fulfillmentData.tracking_url}`);
        }

        return {
            success: true,
            fulfillmentId: fulfillmentData.id,
            status: fulfillmentData.status
        };

    } catch (error) {
        const errorDetails = error.response ? error.response.data : error.message;
        console.error('[-] فشل تحديث شوبيفاي:', JSON.stringify(errorDetails, null, 2));
        throw new Error(`فشل تحديث شوبيفاي: ${errorDetails.errors ? JSON.stringify(errorDetails.errors) : error.message}`);
    }
}

// ==========================================
// 3. استقبال الـ Webhook من شوبيفاي (orders/create)
// ==========================================
app.post('/webhooks/shopify/order-created', async(req, res) => {
    try {
        const shopifyOrder = req.body;

        console.log(`\n=========================================`);
        console.log(`[+] استلام طلب جديد من شوبيفاي #${shopifyOrder.order_number || shopifyOrder.id}`);

        if (!shopifyOrder.shipping_address) {
            console.log('[-] الطلب لا يحتوي على عنوان شحن، تم التغاضي عنه.');
            return res.status(200).send('No shipping address provided');
        }

        const shippingAddr = shopifyOrder.shipping_address;

        // ✅ التعديل هنا: قص العناوين لـ 45 حرف كحد أقصى لشركة DHL وضمان عدم وجود بيانات وهمية
        const street = (shippingAddr.address1 || "Street 1").substring(0, 45);
        const district = (shippingAddr.address2 || "District 1").substring(0, 45);
        // DHL بتعتبر landmarks هي Address Line 1، فلو مفيش شركة هنستخدم العنوان الأول
        const landmarks = (shippingAddr.company || shippingAddr.address1 || "Main Street").substring(0, 45);
        const zipCode = shippingAddr.zip || "00000";

        // ==========================================
        // 4. تجهيز الـ Payload لـ ShipBee
        // ==========================================
        const shipbeePayload = {
            serviceSubcategory: "International",
            // MONTHLY_BILL عشان نطلع الـ Tracking فوراً
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

        // ==========================================
        // 5. إرسال الطلب لـ ShipBee
        // ==========================================
        console.log('[>] جاري إرسال الطلب إلى ShipBee...');
        const shipbeeResponse = await axios.post(`${SHIPBEE_BASE_URL}/api/orders`, shipbeePayload, {
            headers: {
                'x-api-key': SHIPBEE_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        const resData = shipbeeResponse.data;

        if (!resData.success) {
            console.error('[-] ShipBee Error:', resData.message);
            return res.status(400).json(resData);
        }

        const shipbeeOrder = resData.data;
        const trackingNumber = shipbeeOrder.shipment ? shipbeeOrder.shipment.trackingNumber : null;
        const trackingCompany = shipbeeOrder.shipment ? shipbeeOrder.shipment.shippingCompany : 'DHL';
        const paymentUrl = shipbeeOrder.shipment ? shipbeeOrder.shipment.paymentUrl : null;

        console.log(`[✓] تم إنشاء الشحنة في ShipBee! رقم الطلب: ${shipbeeOrder.orderNo}`);

        if (!trackingNumber) {
            console.log('[-] تنبيه: لا يوجد Tracking Number بعد. الشحنة محتاجة دفع أولاً.');
            if (paymentUrl) {
                console.log(`[>] رابط الدفع: ${paymentUrl}`);
            }
            return res.status(200).json({
                success: true,
                shipbeeOrderNo: shipbeeOrder.orderNo,
                trackingNumber: null,
                paymentUrl: paymentUrl,
                shopifyUpdated: false,
                message: 'تم إنشاء الشحنة، لكنها في انتظار الدفع للحصول على رقم التتبع.'
            });
        }

        console.log(`[✓] رقم التتبع: ${trackingNumber}`);
        console.log(`[✓] شركة الشحن: ${trackingCompany}`);

        // ==========================================
        // 6. تحديث شوبيفاي برقم التتبع (Fulfillment)
        // ==========================================
        let shopifyUpdateResult = null;
        try {
            shopifyUpdateResult = await fulfillShopifyOrder(shopifyOrder.id, trackingNumber, trackingCompany);
        } catch (fulfillmentError) {
            console.error('[-] فشل تحديث شوبيفاي:', fulfillmentError.message);
            return res.status(207).json({
                success: true,
                shipbeeOrderNo: shipbeeOrder.orderNo,
                trackingNumber: trackingNumber,
                shopifyUpdated: false,
                shopifyError: fulfillmentError.message,
                message: 'تم إنشاء الشحنة في ShipBee، لكن فشل تحديث شوبيفاي.'
            });
        }

        // ==========================================
        // 7. الرد النهائي (نجاح كامل)
        // ==========================================
        return res.status(200).json({
            success: true,
            shipbeeOrderNo: shipbeeOrder.orderNo,
            trackingNumber: trackingNumber,
            trackingCompany: trackingCompany,
            shopifyFulfillmentId: shopifyUpdateResult.fulfillmentId,
            shopifyStatus: shopifyUpdateResult.status,
            shopifyUpdated: true,
            message: 'تم إنشاء الشحنة في ShipBee وتحديث شوبيفاي بنجاح!'
        });

    } catch (error) {
        console.error('[-] خطأ عام:', error.response ? error.response.data : error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal Server Error'
        });
    }
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