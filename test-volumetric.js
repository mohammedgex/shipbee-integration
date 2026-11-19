'use strict';

// ═══════════════════════════════════════════════════════════════════
// Test Qatar Post pricing — send VOLUMETRIC weight (not actual)
// Run: node test-volumetric.js
// ═══════════════════════════════════════════════════════════════════

const axios = require('axios');

const API_KEY = 'qi8b5e4d6mvs70z1anv2e5gjlteqh0';
const BASE_URL = 'https://api.shipbee.io';

// 10 diverse products — mix of weights and dimensions
const products = [
    { id: 'P24', name: 'PEAR-SMALL', length: 7, width: 6, height: 9, actual: 0.225, previousPrice: 55.55 },
    { id: '30204100062', name: 'LEATHER DESK SET (small)', length: 16.5, width: 7.5, height: 15, actual: 0.335, previousPrice: 55.55 },
    { id: '30204100038', name: 'LEATHER PHOTO FRAME-L', length: 33, width: 5, height: 28, actual: 1.025, previousPrice: 69.69 },
    { id: 'P175', name: 'ARTWORK-15-ALOLA', length: 48, width: 5, height: 43, actual: 1.21, previousPrice: 69.69 },
    { id: '30204100078', name: 'VASE 20-SMALL', length: 19, width: 13, height: 37, actual: 2.08, previousPrice: 83.83 },
    { id: '30204100072', name: 'LEATHER DESK SET (large)', length: 59.5, width: 5.5, height: 46, actual: 1.127, previousPrice: 69.69 },
    { id: '30204100001', name: 'Handmade Candle-Big', length: 26, width: 26, height: 34, actual: 5.115, previousPrice: 126.25 },
    { id: '30204100089', name: 'VASE 37 SCULPTURE', length: 47.5, width: 34.5, height: 31, actual: 4.915, previousPrice: 119.18 },
    { id: '30204100109', name: 'LAMPSHADE (Lamp 11)', length: 49, width: 49, height: 35, actual: 1.93, previousPrice: 76.76 },
    { id: 'P92', name: 'TABLE LAMP-04 LAMPSHADE', length: 47, width: 47, height: 47, actual: 1.595, previousPrice: 76.76 }
];

function volumetricWeight(p) {
    return Math.round((p.length * p.width * p.height / 5000) * 1000) / 1000;
}

async function getPrice(product, weightToSend) {
    const params = {
        serviceSubcategory: 'International',
        fromCountry: 'Qatar',
        fromCity: 'Doha',
        toCountry: 'Saudi Arabia',
        toCity: 'Riyadh',
        toPostCode: '12211',
        weight: weightToSend,
        length: product.length,
        width: product.width,
        height: product.height,
        incoterm: 'DDU',
        shippingCompany: 'Qatar Post',
        plannedShippingDate: '2026-11-25'
    };

    try {
        const response = await axios.get(`${BASE_URL}/api/pricing/calculate`, {
            params,
            headers: { 'x-api-key': API_KEY },
            timeout: 20000
        });

        const days = Array.isArray(response.data) ? response.data : (response.data.data || []);
        for (const day of days) {
            const qp = (day.carriers || []).find(c => c.carrier === 'Qatar Post');
            if (qp && Number(qp.totalCost) > 0) {
                return { price: Number(qp.totalCost), date: day.date };
            }
        }
        return { price: null, error: 'No valid Qatar Post price' };
    } catch (error) {
        return {
            price: null,
            error: error.response.data.message || error.message
        };
    }
}

(async () => {
    console.log('\n' + '═'.repeat(75));
    console.log('  Qatar Post pricing — SENDING VOLUMETRIC WEIGHT (not actual)');
    console.log('═'.repeat(75));
    console.log('\n📊 Comparison against previous results (which used ACTUAL weight)\n');

    for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const vol = volumetricWeight(p);
        const result = await getPrice(p, vol);

        console.log(`[${i + 1}/10] 📦 ${p.name}`);
        console.log(`       Dimensions : ${p.length} × ${p.width} × ${p.height} cm`);
        console.log(`       Actual     : ${p.actual} kg`);
        console.log(`       Volumetric : ${vol} kg  ← SENT TO API`);

        if (result.price) {
            const diff = result.price - p.previousPrice;
            const diffPct = ((diff / p.previousPrice) * 100).toFixed(1);
            const arrow = diff > 0 ? '⬆️' : diff < 0 ? '⬇️' : '➡️';
            console.log(`       ✅ New Price : ${result.price} QAR  ${arrow} (${diff > 0 ? '+' : ''}${diff.toFixed(2)} QAR / ${diffPct}%)`);
            console.log(`       📌 Old Price : ${p.previousPrice} QAR  (with actual ${p.actual} kg)`);
        } else {
            console.log(`       ❌ Failed   : ${result.error}`);
        }
        console.log('');

        if (i < products.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    console.log('═'.repeat(75));
    console.log('✅ Done. Send me the full output for analysis.');
    console.log('═'.repeat(75) + '\n');
})();