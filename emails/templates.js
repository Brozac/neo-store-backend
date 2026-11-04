// emails/templates.js — Laclarc Email Design System (SERENE EDITION v2 · F#84)
// جميع إيميلات الزبون بالإنجليزية — هوية laclarc.com الحقيقية (app/globals.css Serene Edition v2.0 ضباب أزرق)
// Palette: primary #5B7EA6 · deep #46648A · ink #2E4057 · footer #22303F · line #E2EBF3 · page #F4F8FB
//          gold #C9A96A (stars) · roseText #B05C5C (prices/discount) · green #7C9E85 (free) · greenBright #88C83C (trust)
// Brand word: Marcellus serif uppercase (site .font-brand) — body: system sans (Tailwind default)
// Header = نسخة طبق الأصل من Navbar: شريط إعلانات #2E4057 + غراديان #2E4057→#5B7EA6→#2E4057 + لوجو icon-512 في بوك أبيض
// Footer = نسخة طبق الأصل من Footer.tsx: #22303F + روابط Storefront/Trust + © Powered by Stripe, Paysera, and NowPayments
// Table-based layout · inline CSS only · 600px · Outlook/Gmail-safe (no flex, no grid, no background-image text)

'use strict';

const SITE = process.env.FRONTEND_URL || 'https://laclarc.com';

const C = {
  primary:     '#5B7EA6', // fog-500 — أزرار/أكسنت (site --serene-primary)
  primaryDeep: '#46648A', // fog-600 — hover/روابط نصية (--serene-primary-deep)
  bright:      '#3A5475', // fog-700
  ink:         '#2E4057', // fog-800 — عناوين ونص أساسي (--serene-ink)
  footerBg:    '#22303F', // fog-900 — فوتر الموقع (Footer.tsx bg-[#22303F])
  soft:        '#A8C3DC', // fog-300
  softMid:     '#7FA1C4', // fog-400 — أيقونة القفل في شريط الإعلانات
  fog:         '#DCE9F4', // fog-100 — بانلات فاتحة
  page:        '#F4F8FB', // fog-50/offwhite — خلفية الإيميل (--serene-bg)
  panel:       '#F4F8FB', // بانل معلومات
  card:        '#FFFFFF',
  line:        '#E2EBF3', // حدود (--serene-line)
  muted:       '#7A8CA0', // ink-soft — نص ثانوي (--serene-ink-soft)
  gold:        '#C9A96A', // ذهبي النجوم (--serene-gold)
  butter:      '#D0AC48', // butter-up-400 — برق الإعلان
  rose:        '#D98A8A', // coral-500 — قلوب/خصم (--serene-rose)
  roseText:    '#B05C5C', // coral-600 — نص الأسعار على فاتح
  green:       '#7C9E85', // أخضر «مجاني» الوحيد في الهوية
  greenBright: '#88C83C', // maroccan-tea-400 — أيقونة الشحن/ثقة المشتري
  footerTx:    '#9CA3AF', // gray-400 نص الفوتر
  footerDm:    '#7C8B9A', // أغمق للحقوق
  footerLine:  '#3B4C5E', // ~border-white/10 على #22303F
};

const F_BODY  = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const F_SERIF = "'Marcellus',Georgia,'Times New Roman',serif";

// escape any dynamic value (title, name…) before it touches the HTML
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

// hidden preheader = inbox preview text
function preheader(txt) {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${esc(txt)}</div>`;
}

// bulletproof button — same anatomy as site CTA (bg #5B7EA6 · radius 12px · uppercase · tracking)
function button(url, label, opts = {}) {
  const bg = opts.bg || C.primary;
  return `
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 0;">
            <tr>
              <td align="center" bgcolor="${bg}" style="border-radius:12px;">
                <a href="${url}" style="display:inline-block;padding:15px 34px;font-family:${F_BODY};font-size:13px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:12px;letter-spacing:1.2px;text-transform:uppercase;">${label}</a>
              </td>
            </tr>
          </table>`;
}

// info box with colored left border (panel bg = fog-50 · radius 12px مثل site --radius-temu-sm)
function infoBox(title, text, accent = C.primary) {
  return `
          <div style="background:${C.panel};border-left:4px solid ${accent};border-radius:8px;padding:14px 16px;margin-top:26px;">
            <p style="margin:0;font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.ink};">${title}</p>
            <p style="margin:5px 0 0;font-family:${F_BODY};font-size:12px;color:${C.muted};line-height:1.6;">${text}</p>
          </div>`;
}

// dashed promo box (rose #D98A8A — لون الخصم الرسمي) with a code pill (primary)
function promoBox(label, pill) {
  return `
          <div style="background:${C.card};border:2px dashed ${C.rose};border-radius:12px;padding:15px;text-align:center;margin-top:26px;">
            <p style="margin:0 0 8px;font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;color:${C.ink};">${label}</p>
            <span style="display:inline-block;background:${C.primary};color:#FFFFFF;padding:7px 18px;border-radius:8px;font-family:${F_BODY};font-weight:bold;font-size:15px;letter-spacing:1px;">${pill}</span>
          </div>`;
}

// شريط الإعلانات العلوي — نسخة طبق الأصل من Navbar.tsx (bg #2E4057 · أبيض 11px bold · tracking-wide)
// الأخضر #88C83C شحن · الذهبي #D0AC48 ضمان · الأزرق #7FA1C4 قفل (نفس ألوان أيقونات الموقع)
function announcementBar() {
  return `
          <tr>
            <td bgcolor="${C.ink}" align="center" style="background:${C.ink};padding:9px 12px;">
              <p style="margin:0;font-family:${F_BODY};font-size:10px;font-weight:bold;letter-spacing:0.6px;color:#FFFFFF;white-space:nowrap;">
                <span style="color:${C.greenBright};">&#10003;</span> Free Worldwide Express Shipping
                <span style="color:${C.soft};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>
                <span style="color:${C.butter};">&#9889;</span> 100% Satisfaction Guarantee
                <span style="color:${C.soft};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>
                <span style="color:${C.softMid};">&#10003;</span> Bank-Grade Secure Checkout
              </p>
            </td>
          </tr>`;
}

// شريط البراند — غراديان النافبار (#2E4057 → #5B7EA6 → #2E4057) + اللوجو في بوك أبيض + LACLARC بخط Marcellus
// (Outlook ي fallback إلى bgcolor #2E4057 — نفس روح الهوية)
function brandBand() {
  return `
          <tr>
            <td bgcolor="${C.ink}" align="center" style="background:${C.ink};background-image:linear-gradient(90deg,${C.ink} 0%,${C.primary} 50%,${C.ink} 100%);padding:18px 32px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td valign="middle" style="padding-right:12px;">
                    <img src="${SITE}/icon-512.png" width="40" height="40" alt="Laclarc" style="display:block;width:40px;height:40px;border-radius:10px;background:#FFFFFF;">
                  </td>
                  <td valign="middle">
                    <div style="font-family:${F_SERIF};font-size:26px;font-weight:bold;letter-spacing:5px;color:#FFFFFF;">LACLARC</div>
                    <div style="font-family:${F_BODY};font-size:9px;font-weight:bold;letter-spacing:2.4px;color:${C.fog};text-transform:uppercase;margin-top:3px;">Curated Lifestyle &amp; Electric Grooming</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

// فوتر الموقع — نسخة طبق الأصل من Footer.tsx (bg #22303F · بوك لوجو أبيض · أعمدة Storefront/Trust · صف الدفع)
function siteFooter() {
  const year = new Date().getFullYear();
  const colHead = (txt) => `<p style="margin:0 0 9px;font-family:${F_BODY};font-size:10px;font-weight:bold;letter-spacing:1.2px;color:#FFFFFF;text-transform:uppercase;">${txt}</p>`;
  const link = (href, txt) => `<a href="${href}" style="color:${C.footerTx};text-decoration:none;font-family:${F_BODY};font-size:11px;line-height:2;">${txt}</a>`;
  return `
          <tr>
            <td bgcolor="${C.footerBg}" style="background:${C.footerBg};padding:28px 32px 20px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center">
                      <tr>
                        <td valign="middle" style="padding-right:10px;">
                          <img src="${SITE}/icon-512.png" width="34" height="34" alt="Laclarc" style="display:block;width:34px;height:34px;border-radius:8px;background:#FFFFFF;">
                        </td>
                        <td valign="middle">
                          <div style="font-family:${F_SERIF};font-size:21px;font-weight:bold;letter-spacing:4px;color:#FFFFFF;">LACLARC</div>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:12px auto 0;max-width:420px;font-family:${F_BODY};font-size:11px;color:${C.footerTx};line-height:1.7;">Your global flagship store for curated lifestyle gear, electric grooming innovations, and verified daily essentials.</p>
                    <p style="margin:12px 0 0;font-family:${F_BODY};font-size:11px;font-weight:bold;color:${C.greenBright};">&#10003; 100% Buyer Protection Guaranteed</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 0 0;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="50%" align="center" valign="top" style="padding:0 8px;">
                          ${colHead('Storefront')}
                          <p style="margin:0;">
                            ${link(`${SITE}/`, 'Trending Home')}<br>
                            ${link(`${SITE}/categories`, 'All Departments')}<br>
                            ${link(`${SITE}/track-order`, 'Track Shipment')}<br>
                            ${link(`${SITE}/favorites`, 'Saved Wishlist')}<br>
                            ${link(`${SITE}/cart`, 'Shopping Bag')}
                          </p>
                        </td>
                        <td width="50%" align="center" valign="top" style="padding:0 8px;">
                          ${colHead('Trust &amp; Policies')}
                          <p style="margin:0;">
                            ${link(`${SITE}/refund`, 'Refund &amp; Return Policy')}<br>
                            ${link(`${SITE}/privacy`, 'Privacy Policy (GDPR)')}<br>
                            ${link(`${SITE}/terms`, 'Terms of Service')}<br>
                            ${link(`${SITE}/track-order`, 'Where Is My Order?')}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 0 0;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid ${C.footerLine};">
                      <tr>
                        <td align="center" style="padding:14px 0 0;">
                          <p style="margin:0;font-family:${F_BODY};font-size:10px;color:${C.footerTx};line-height:1.8;">&copy; ${year} <strong style="color:#FFFFFF;">Laclarc</strong>. All rights reserved. Powered by Stripe, Paysera, and NowPayments.</p>
                          <p style="margin:6px 0 0;font-family:${F_BODY};font-size:10px;font-weight:bold;color:${C.footerTx};letter-spacing:0.5px;">Visa &amp; MasterCard &nbsp;&middot;&nbsp; Apple Pay &nbsp;&middot;&nbsp; USDT &amp; Crypto</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

// shared wrapper: announcement bar → gradient brand band → body (tagline chip + content) → reason → site footer
function layout({ tagline, pre, body, reason }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <link href="https://fonts.googleapis.com/css2?family=Marcellus&amp;display=swap" rel="stylesheet">
  <title>Laclarc</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
${preheader(pre)}
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:0 0 28px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:${C.card};border-radius:0 0 16px 16px;border:1px solid ${C.line};border-top:0;overflow:hidden;">
${announcementBar()}
${brandBand()}
          <tr>
            <td style="padding:24px 32px 30px;">
              <p style="margin:0 0 10px;font-family:${F_BODY};font-size:10px;font-weight:bold;letter-spacing:2.2px;color:${C.primaryDeep};text-transform:uppercase;">${tagline}</p>
${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 20px;">
              <p style="margin:0;font-family:${F_BODY};font-size:11px;color:${C.muted};line-height:1.5;">${reason}</p>
            </td>
          </tr>
${siteFooter()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// item row (order confirmation + abandoned cart share the same anatomy)
function itemRow(imgUrl, title, qtyLabel, price) {
  const img = imgUrl || `${SITE}/icon-192.png`;
  return `
              <tr>
                <td style="padding:14px 0;border-bottom:1px solid ${C.line};width:66px;vertical-align:top;">
                  <img src="${imgUrl ? esc(imgUrl) : img}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid ${C.line};">
                </td>
                <td style="padding:14px 0 14px 14px;border-bottom:1px solid ${C.line};vertical-align:top;">
                  <div style="font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.ink};line-height:1.4;">${esc(title)}</div>
                  <div style="font-family:${F_BODY};font-size:12px;color:${C.muted};margin-top:3px;">${qtyLabel}</div>
                </td>
                <td style="padding:14px 0;border-bottom:1px solid ${C.line};text-align:right;vertical-align:top;font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.roseText};white-space:nowrap;">${money(price)}</td>
              </tr>`;
}

function h2(txt) {
  return `<h2 style="margin:0;font-family:${F_BODY};font-size:21px;font-weight:bold;color:${C.ink};line-height:1.3;">${txt}</h2>`;
}

function p(txt, opts = {}) {
  return `<p style="margin:${opts.mt == null ? '12px' : opts.mt} 0 0;font-family:${F_BODY};font-size:14px;color:${C.ink};line-height:1.65;">${txt}</p>`;
}

// ————————————————————————————————
// 1) ORDER CONFIRMATION
// ————————————————————————————————
function orderSubject(orderNumber, orderId) {
  const num = orderNumber || `#${orderId}`;
  return `Order ${num} confirmed — thank you!`;
}

function orderConfirmation({ orderId, orderNumber, total, items = [], customerName }) {
  const num = esc(orderNumber || `#${orderId}`);
  const rows = items.map(it => itemRow(it.image_url, it.title || 'Product', `Qty: ${it.quantity}`, it.price_at_purchase)).join('');
  const hi = customerName ? `Hi <strong>${esc(customerName)}</strong>,` : 'Hello,';

  const body = `
              ${h2('Thank you for your order! 🎉')}
              ${p(`${hi} we received your order <strong style="color:${C.primaryDeep};">${num}</strong> and it is already being prepared.`)}
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px;background:${C.panel};border:1px solid ${C.line};border-radius:12px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <span style="font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;color:${C.muted};text-transform:uppercase;">Order</span><br>
                    <span style="font-family:${F_BODY};font-size:16px;font-weight:bold;color:${C.ink};">${num}</span>
                  </td>
                  <td align="right" style="padding:14px 16px;">
                    <span style="display:inline-block;background:${C.primary};color:#FFFFFF;font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;padding:6px 14px;border-radius:20px;">CONFIRMED ✓</span>
                  </td>
                </tr>
              </table>
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:22px;">
                <tr>
                  <th align="left" style="padding-bottom:10px;border-bottom:2px solid ${C.primary};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Your items</th>
                  <th align="right" style="padding-bottom:10px;border-bottom:2px solid ${C.primary};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Price</th>
                </tr>${rows}
              </table>
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
                <tr>
                  <td align="right" style="font-family:${F_BODY};font-size:14px;font-weight:bold;color:${C.ink};">Total paid:&nbsp;
                    <span style="font-size:21px;color:${C.roseText};">${money(total)}</span>
                  </td>
                </tr>
              </table>
              ${infoBox('What happens next?', '1. Payment confirmed ✓ &nbsp;·&nbsp; 2. We prepare your order and hand it to our fulfillment partner (CJ Dropshipping). &nbsp;·&nbsp; 3. You get your tracking number by email as soon as it ships.', C.primary)}
              ${button(`${SITE}/track-order`, 'Track My Order')}
              ${p(`<span style="color:${C.green};font-size:12px;font-weight:bold;">✓ Free Worldwide Express Shipping</span> &nbsp;·&nbsp; <a href="${SITE}" style="color:${C.primaryDeep};font-weight:bold;text-decoration:none;">Continue shopping →</a>`, { mt: '18px' })}`;

  return layout({
    tagline: 'Worldwide Insured Shipping',
    pre: `Your order ${orderNumber || `#${orderId}`} is confirmed. Tracking to follow.`,
    body,
    reason: 'You received this email because you placed an order on laclarc.com.',
  });
}

// ————————————————————————————————
// 2) VERIFY EMAIL (WELCOME)
// ————————————————————————————————
function verifyEmail({ name, verifyUrl }) {
  const hi = name ? `Welcome to Laclarc, <strong>${esc(name)}</strong>!` : 'Welcome to Laclarc!';
  const body = `
              ${h2(hi)}
              ${p('You are one click away. Confirm your email address to activate your account and start shopping.')}
              ${button(verifyUrl, 'Verify My Email')}
              ${p('This link expires in 24 hours.', { mt: '18px' })}
              ${p(`<span style="color:${C.muted};font-size:12px;">Didn't sign up on Laclarc? You can safely ignore this email.</span>`)}`;

  return layout({
    tagline: 'Confirm Your Email',
    pre: 'One click to activate your Laclarc account.',
    body,
    reason: 'You received this email because someone created an account at laclarc.com with this address.',
  });
}

// ————————————————————————————————
// 3) PASSWORD RESET
// ————————————————————————————————
function passwordReset({ resetUrl }) {
  const body = `
              ${h2('Reset your password')}
              ${p('We received a request to reset the password for your Laclarc account. Click the button below to choose a new one.')}
              ${button(resetUrl, 'Choose a New Password')}
              ${infoBox('This link expires in 15 minutes', `If you didn't request a password reset, your account is safe — just ignore this email and your password stays unchanged.`, C.roseText)}`;

  return layout({
    tagline: 'Account Security',
    pre: 'A password reset was requested for your Laclarc account.',
    body,
    reason: 'You received this email because a password reset was requested at laclarc.com.',
  });
}

// ————————————————————————————————
// 4) ABANDONED CART RECOVERY (RECOVER10)
// ————————————————————————————————
function abandonedCart({ customerName, orderNumber, orderId, items = [] }) {
  const num = esc(orderNumber || `#${orderId}`);
  const hi = customerName ? `Hello <strong>${esc(customerName)}</strong>,` : 'Hello,';
  const rows = items.map(it => itemRow(it.image_url, it.title || 'Product', `Qty: ${it.quantity} · ${money(it.price_at_purchase)}`, it.price_at_purchase)).join('');

  const body = `
              ${h2('You left something behind… 👀')}
              ${p(`${hi} your items are still reserved in your bag — but flash inventory moves fast, and the pieces you picked are selling out.`)}
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px;">
                <tr>
                  <th align="left" style="padding-bottom:10px;border-bottom:2px solid ${C.primary};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Your bag</th>
                  <th align="right" style="padding-bottom:10px;border-bottom:2px solid ${C.primary};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Order ${num}</th>
                </tr>${rows}
              </table>
              ${promoBox('USE THIS EXCLUSIVE 10% RECOVERY DISCOUNT', 'RECOVER10')}
              ${button(`${SITE}/cart`, 'Complete My Order →')}
              ${p('<span style="color:' + C.muted + ';font-size:12px;"><span style="color:' + C.green + ';font-weight:bold;">✓ Free Worldwide Insured Shipping</span> &bull; 30-Day Money-Back Guarantee</span>', { mt: '18px' })}`;

  return layout({
    tagline: 'Your Cart Is Waiting',
    pre: 'Your items are still reserved — 10% OFF inside.',
    body,
    reason: 'You received this email because you started a checkout at laclarc.com.',
  });
}

// ————————————————————————————————
// 5) REVIEW INVITE (5% OFF)
// ————————————————————————————————
function reviewInvite({ customerName, orderId, orderNumber, reviewUrl, product }) {
  const num = esc(orderNumber || `#${orderId}`);
  const hi = customerName ? `Hello <strong>${esc(customerName)}</strong>,` : 'Hello,';
  const imgHtml = product && product.image_url
    ? `<div style="text-align:center;margin-top:22px;"><img src="${esc(product.image_url)}" alt="" style="max-width:190px;width:100%;height:auto;border-radius:12px;border:1px solid ${C.line};"></div>`
    : '';

  const body = `
              ${h2('How was your order? <span style="color:' + C.gold + ';">★</span>')}
              ${p(`${hi} your order <strong style="color:${C.primaryDeep};">${num}</strong> has been delivered! We hope you love it.`)}
              ${imgHtml}
              ${p('Your honest review takes one minute and helps thousands of shoppers — and helps us get better every day.', { mt: '16px' })}
              ${promoBox('WRITE A REVIEW & GET', '5% OFF NEXT ORDER')}
              ${button(reviewUrl, 'Write My Review')}
              ${p(`<span style="color:${C.muted};font-size:12px;">This link is unique to your order.</span>`, { mt: '18px' })}`;

  return layout({
    tagline: 'Your Opinion Matters',
    pre: `Tell us about order ${orderNumber || `#${orderId}`} — get 5% off.`,
    body,
    reason: 'You received this email because you shopped with us at laclarc.com.',
  });
}

module.exports = {
  esc, money, layout, button, infoBox, promoBox,
  orderConfirmation, orderSubject,
  verifyEmail, passwordReset, abandonedCart, reviewInvite,
  _colors: C,
};
