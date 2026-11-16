'use strict';

// ═══════════════════════════════════════════════════════════════════
// Qatar Post Rates Collector — GCC Countries Test
// Run: node collect-qatar-post-rates.js
// Uses /api/pricing/calculate (NO real shipments created)
// ═══════════════════════════════════════════════════════════════════

const axios = require('axios');
const fs = require('fs');

// ─── Configuration ────────────────────────────────────────────────
const CONFIG = {
    apiKey: 'qi8b5e4d6mvs70z1anv2e5gjlteqh0',
    baseUrl: 'https://api.shipbee.io',
    productsFile: './product-packaging.json',
    outputFile: './qatar-post-rates-gcc.json',
    delayMs: 1500,
    resume: true,
    samplesPerTier: 2,
    shippingCompany: 'Qatar Post'
};

// ─── GCC Countries with capitals + zip codes ──────────────────────
// Zip codes are required for Qatar Post (mandatory for non-Qatar countries)
const GCC_COUNTRIES = [
    { country: 'Saudi Arabia', city: 'Riyadh', zipCode: '12211' },
    { country: 'United Arab Emirates', city: 'Dubai', zipCode: '00000' },
    { country: 'Kuwait', city: 'Kuwait City', zipCode: '13001' },
    { country: 'Bahrain', city: 'Manama', zipCode: '317' },
    { country: 'Oman', city: 'Muscat', zipCode: '112' }
];

// ─── Load products ────────────────────────────────────────────────
if (!fs.existsSync(CONFIG.productsFile)) {
    console.error(`❌ File not found: ${CONFIG.productsFile}`);
    process.exit(1);
}

let raw;
try {
    raw = JSON.parse(fs.readFileSync(CONFIG.productsFile, 'utf8'));
} catch (e) {
    console.error(`❌ Invalid JSON: ${e.message}`);
    process.exit(1);
}

const products = Array.isArray(raw) ? raw : (raw.products || []);
if (!products.length) {
    console.error('❌ No products found');
    process.exit(1);
}

console.log(`📦 Loaded ${products.length} products`);

// ─── Build candidates ─────────────────────────────────────────────
const candidates = products
    .filter(p => p.weightKg > 0 && p.length > 0 && p.width > 0 && p.height > 0)
    .map((p, i) => {
        const volumetric = (p.length * p.width * p.height) / 5000;
        return {
            id: p.sku && String(p.sku).trim() ? String(p.sku).trim() : `P${i + 1}`,
            name: p.name || 'Unknown',
            weight: Number(p.weightKg),
            length: Number(p.length),
            width: Number(p.width),
            height: Number(p.height),
            volumetric: Number(volumetric.toFixed(3)),
            chargeable: Number(Math.max(p.weightKg, volumetric).toFixed(3))
        };
    });

// ─── Deduplicate ──────────────────────────────────────────────────
const seen = new Set();
const unique = candidates.filter(p => {
    const key = `${p.weight}|${p.length}|${p.width}|${p.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
});

console.log(`✅ Valid products : ${candidates.length}`);
console.log(`🎯 Unique specs   : ${unique.length}`);

// ─── Pick representatives per weight tier ─────────────────────────
let selectedProducts;
if (CONFIG.samplesPerTier > 0) {
    const tiers = [
        { min: 0, max: 1.0 },
        { min: 1.0, max: 2.0 },
        { min: 2.0, max: 3.0 },
        { min: 3.0, max: 5.0 },
        { min: 5.0, max: 7.5 },
        { min: 7.5, max: 10.0 },
        { min: 10.0, max: 15.0 },
        { min: 15.0, max: 20.0 },
        { min: 20.0, max: 999 }
    ];
    selectedProducts = [];
    for (const tier of tiers) {
        const inTier = unique
            .filter(p => p.chargeable > tier.min && p.chargeable <= tier.max)
            .sort((a, b) => a.chargeable - b.chargeable)
            .slice(0, CONFIG.samplesPerTier);
        selectedProducts.push(...inTier);
    }
    console.log(`📊 Using ${selectedProducts.length} representative products (${CONFIG.samplesPerTier} per tier)`);
} else {
    selectedProducts = unique;
    console.log(`📊 Using ALL ${selectedProducts.length} products`);
}

// ─── Build test matrix ────────────────────────────────────────────
const testCases = [];
for (const { country, city, zipCode }
    of GCC_COUNTRIES) {
    for (const p of selectedProducts) {
        testCases.push({
            ...p,
            toCountry: country,
            toCity: city,
            toZipCode: zipCode,
            caseKey: `${p.id}__${country.replace(/\s+/g, '_')}`
        });
    }
}

console.log(`\n🌍 Carrier      : ${CONFIG.shippingCompany}`);
console.log(`🌍 Countries    : ${GCC_COUNTRIES.length}`);
console.log(`📦 Products     : ${selectedProducts.length}`);
console.log(`📊 Total calls  : ${testCases.length}`);
console.log(`⏱️  Duration     : ~${Math.ceil(testCases.length * CONFIG.delayMs / 60000)} min\n`);

// ─── Resume ───────────────────────────────────────────────────────
let previousResults = [];
if (CONFIG.resume && fs.existsSync(CONFIG.outputFile)) {
    try {
        previousResults = JSON.parse(fs.readFileSync(CONFIG.outputFile, 'utf8'));
        if (!Array.isArray(previousResults)) previousResults = [];
        const doneKeys = new Set(previousResults.filter(r => r.valid).map(r => r.caseKey));
        const filtered = testCases.filter(tc => !doneKeys.has(tc.caseKey));
        console.log(`♻️  Resuming: ${previousResults.length} done, ${filtered.length} remaining`);
        testCases.length = 0;
        testCases.push(...filtered);
    } catch (e) {
        console.warn(`⚠️  Could not resume: ${e.message}`);
    }
}

if (!testCases.length) {
    console.log('\n✅ All cases already done.');
    process.exit(0);
}

// ─── Fetch one quote ──────────────────────────────────────────────
async function getQuote(tc) {
    const params = {
        serviceSubcategory: 'International',
        fromCountry: 'Qatar',
        fromCity: 'Doha',
        toCountry: tc.toCountry,
        toCity: tc.toCity,
        toPostCode: tc.toZipCode,
        weight: tc.weight,
        length: tc.length,
        width: tc.width,
        height: tc.height,
        incoterm: 'DDU',
        shippingCompany: CONFIG.shippingCompany,
        plannedShippingDate: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10)
    };

    try {
        const response = await axios.get(`${CONFIG.baseUrl}/api/pricing/calculate`, {
            params,
            headers: { 'x-api-key': CONFIG.apiKey },
            timeout: 20000
        });

        const days = Array.isArray(response.data) ? response.data :
            (response.data && response.data.data) || [];

        for (const day of days) {
            const qp = (day.carriers || []).find(c => c.carrier === CONFIG.shippingCompany);
            if (qp && Number(qp.totalCost) > 0) {
                return {
                    caseKey: tc.caseKey,
                    id: tc.id,
                    name: tc.name,
                    toCountry: tc.toCountry,
                    toCity: tc.toCity,
                    toZipCode: tc.toZipCode,
                    actualWeight: tc.weight,
                    length: tc.length,
                    width: tc.width,
                    height: tc.height,
                    volumetricWeight: tc.volumetric,
                    chargeableWeight: tc.chargeable,
                    totalCost: Number(qp.totalCost),
                    currency: qp.currency || 'QAR',
                    estimatedDeliveryDays: qp.estimatedDeliveryDays || null,
                    quotedDate: day.date,
                    valid: true,
                    reason: null
                };
            }
        }

        return {
            caseKey: tc.caseKey,
            id: tc.id,
            name: tc.name,
            toCountry: tc.toCountry,
            toCity: tc.toCity,
            toZipCode: tc.toZipCode,
            actualWeight: tc.weight,
            length: tc.length,
            width: tc.width,
            height: tc.height,
            volumetricWeight: tc.volumetric,
            chargeableWeight: tc.chargeable,
            totalCost: 0,
            currency: 'QAR',
            valid: false,
            reason: 'Qatar Post returned no valid price'
        };
    } catch (error) {
        const reason = error.response && error.response.data ?
            (error.response.data.message || JSON.stringify(error.response.data).slice(0, 200)) :
            (error.response && `HTTP ${error.response.status}`) || error.message;
        return {
            caseKey: tc.caseKey,
            id: tc.id,
            name: tc.name,
            toCountry: tc.toCountry,
            toCity: tc.toCity,
            toZipCode: tc.toZipCode,
            actualWeight: tc.weight,
            length: tc.length,
            width: tc.width,
            height: tc.height,
            volumetricWeight: tc.volumetric,
            chargeableWeight: tc.chargeable,
            totalCost: null,
            valid: false,
            reason
        };
    }
}

// ─── Run all ──────────────────────────────────────────────────────
(async () => {
    const newResults = [];

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const prog = `[${String(i + 1).padStart(3)}/${testCases.length}]`;
        process.stdout.write(`${prog} ${tc.toCountry.padEnd(22)} (${tc.chargeable}kg) ... `);

        const result = await getQuote(tc);
        newResults.push(result);

        if (result.valid) {
            console.log(`✅ ${result.totalCost} QAR`);
        } else {
            console.log(`❌ ${result.reason.slice(0, 60)}`);
        }

        if ((i + 1) % 10 === 0) {
            fs.writeFileSync(CONFIG.outputFile, JSON.stringify([...previousResults, ...newResults], null, 2));
        }

        if (i < testCases.length - 1) {
            await new Promise(r => setTimeout(r, CONFIG.delayMs));
        }
    }

    const merged = [...previousResults, ...newResults];
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(merged, null, 2));

    const valid = merged.filter(r => r.valid);
    const invalid = merged.filter(r => !r.valid);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📁 Saved: ${CONFIG.outputFile}`);
    console.log(`📊 Total: ${merged.length} | ✅ ${valid.length} | ❌ ${invalid.length}`);

    if (valid.length) {
        console.log(`\n🌍 ${CONFIG.shippingCompany} cost per country (QAR):`);
        const byCountry = {};
        for (const r of valid) {
            if (!byCountry[r.toCountry]) byCountry[r.toCountry] = [];
            byCountry[r.toCountry].push(r);
        }
        for (const [country, rows] of Object.entries(byCountry)) {
            const costs = rows.map(r => r.totalCost);
            const weights = rows.map(r => r.chargeableWeight);
            console.log(`\n   📍 ${country}`);
            console.log(`      Cases : ${rows.length}`);
            console.log(`      Weight: ${Math.min(...weights)} - ${Math.max(...weights)} kg`);
            console.log(`      Price : ${Math.min(...costs).toFixed(2)} - ${Math.max(...costs).toFixed(2)} QAR`);
        }

        // Sample comparison
        console.log(`\n💰 Sample prices (sorted by weight):`);
        const sorted = [...valid].sort((a, b) => a.chargeableWeight - b.chargeableWeight);
        for (const r of sorted.slice(0, 15)) {
            console.log(`   ${String(r.chargeableWeight).padStart(6)} kg → ${String(r.totalCost).padStart(7)} QAR (${r.toCity})`);
        }
    }

    if (invalid.length) {
        console.log(`\n⚠️  Failed cases (${invalid.length}):`);
        const reasons = {};
        for (const r of invalid) {
            const key = (r.reason || 'unknown').slice(0, 60);
            reasons[key] = (reasons[key] || 0) + 1;
        }
        for (const [reason, count] of Object.entries(reasons)) {
            console.log(`   ${count}x ${reason}`);
        }
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📁 Send the file "${CONFIG.outputFile}" for analysis`);
})();