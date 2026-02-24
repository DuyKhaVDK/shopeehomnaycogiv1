// netlify/functions/api.js
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const router = express.Router();

// --- CẤU HÌNH ID (Kha cập nhật trong Netlify Environment Variables) ---
const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const AFF_ID = process.env.AFF_ID || "17335300037"; // ID nhận hoa hồng

const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ & TRÍCH XUẤT ITEM ID (BỘ XỬ LÝ QUAN TRỌNG) ---
async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    

    if (inputUrl.includes('origin_link=')) {
        try {
            const urlObj = new URL(inputUrl);
            finalUrl = urlObj.searchParams.get('origin_link');
        } catch (e) { console.log("Lỗi xử lý link đã bọc"); }
    } 
    

    if (/(s\.shopee\.vn|shp\.ee|s\.shope\.ee|vn\.shp\.ee)/.test(inputUrl) && !inputUrl.includes('origin_link=')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10,
                timeout: 10000, // Tăng timeout cho link rút gọn
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' 
                },
                validateStatus: null
            });
            // Lấy URL trang đích cuối cùng sau khi redirect
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) {
            console.log(`>> Lỗi giải mã link rút gọn: ${inputUrl}`);
        }
    }

    // SAU KHI CÓ LINK GỐC, TRÍCH XUẤT ID SẢN PHẨM (ĐỂ HIỆN ẢNH)
    const dashIMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    const productPathMatch = finalUrl.match(/\/product\/\d+\/(\d+)/);
    const genericIdMatch = finalUrl.match(/(?:itemId=|\/product\/)(\d+)/);
    
    let itemId = null;
    if (dashIMatch) itemId = dashIMatch[2];
    else if (productPathMatch) itemId = productPathMatch[1];
    else if (genericIdMatch) itemId = genericIdMatch[1];
    else {
        const lastDigitMatch = finalUrl.match(/\/(\d+)(?:\?|$)/);
        itemId = lastDigitMatch ? lastDigitMatch[1] : null;
    }

    // Làm sạch link để đưa vào bộ tạo link s.shopee.vn
    let baseUrl = finalUrl.split('?')[0];
    let cleanedUrl = baseUrl;
    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);
    if (match) {
        cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`;
    }

    return { cleanedUrl, itemId };
}

// --- HÀM 2: GỌI API LẤY TÊN & ẢNH (DÙNG APP_ID ĐỂ HIỆN TRÊN WEB) ---
async function getShopeeProductInfo(itemId) {
    if (!itemId || !APP_ID || !APP_SECRET) return null;
    
    const timestamp = Math.floor(Date.now() / 1000);
    const query = `query { productOfferV2(itemId: ${itemId}) { nodes { productName imageUrl } } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256')
        .update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`)
        .digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });
        return response.data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

// --- HÀM 3: TẠO LINK CHUẨN S.SHOPEE.VN (DÙNG AFF_ID 17396720247) ---
function generateUniversalLink(originalUrl, subIds = []) {
    const encodedUrl = encodeURIComponent(originalUrl);
    const prefix = "https://s.shopee.vn/an_redir?origin_link="; 
    let finalSubId = subIds.length > 0 ? subIds.join('-') : "";
    
    return `${prefix}${encodedUrl}&affiliate_id=${AFF_ID}&sub_id=${finalSubId}`;
}

// --- ROUTER XỬ LÝ CHÍNH ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    if (!text) return res.status(400).json({ error: 'Nội dung trống' });

    // Regex nhận diện mọi loại link Shopee
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn|s\.shope\.ee)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        
        // 1. Giải mã link để lấy được ItemID (kể cả link 8KjrdNEQJq)
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(fullUrl);
        
        // 2. Chạy song song: Tạo link mới & Lấy data từ API
        const [short, info] = await Promise.all([
            Promise.resolve(generateUniversalLink(cleanedUrl, subIds)),
            getShopeeProductInfo(itemId)
        ]);

        return { 
            original: url,
            short,
            productName: info?.productName || "Sản phẩm Shopee",
            imageUrl: info?.imageUrl || ""
        };
    }));

    res.json({ 
        success: true, 
        converted: conversions.length, 
        details: conversions 
    });
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);

module.exports.handler = serverless(app);
