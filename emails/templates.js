// emails/templates.js — Laclarc Email Design System (ROSE DUO · v1 · F#83)
// جميع إيميلات الزبون بالإنجليزية ومتناسقة مع هوية laclarc.com
// Palette: lavender #6B3DB4 (primary) · rose #C9465E (accent/price) · ink #1D1E3C
// Table-based layout · inline CSS only · 600px · Outlook/Gmail-safe (no flex, no grid)

'use strict';

const SITE = process.env.FRONTEND_URL || 'https://laclarc.com';

const C = {
  lavender: '#6B3DB4',
  rose:     '#C9465E',
  ink:      '#1D1E3C',
  body:     '#4B5563',
  muted:    '#9CA3AF',
  page:     '#F3F1F8',
  card:     '#FFFFFF',
  line:     '#E9E5F2',
  soft:     '#F9F8FC',
  footerTx: '#B9B3C9',
  footerDm: '#7A7590',
};

const F_BODY  = "'Tajawal','Segoe UI',Helvetica,Arial,sans-serif";
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

// bulletproof pill button (table-based — survives Outlook)
function button(url, label, opts = {}) {
  const bg = opts.bg || C.lavender;
  return `
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 0;">
            <tr>
              <td align="center" bgcolor="${bg}" style="border-radius:30px;">
                <a href="${url}" style="display:inline-block;padding:14px 36px;font-family:${F_BODY};font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:30px;">${label}</a>
              </td>
            </tr>
          </table>`;
}

// info box with colored left border
function infoBox(title, text, accent = C.lavender) {
  return `
          <div style="background:${C.soft};border-left:4px solid ${accent};border-radius:6px;padding:14px 16px;margin-top:26px;">
            <p style="margin:0;font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.ink};">${title}</p>
            <p style="margin:5px 0 0;font-family:${F_BODY};font-size:12px;color:${C.body};line-height:1.6;">${text}</p>
          </div>`;
}

// dashed promo box (rose) with a code/label pill
function promoBox(label, pill) {
  return `
          <div style="background:${C.card};border:2px dashed ${C.rose};border-radius:12px;padding:15px;text-align:center;margin-top:26px;">
            <p style="margin:0 0 8px;font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;color:${C.ink};">${label}</p>
            <span style="display:inline-block;background:${C.lavender};color:#FFFFFF;padding:7px 18px;border-radius:8px;font-family:${F_BODY};font-weight:bold;font-size:15px;letter-spacing:1px;">${pill}</span>
          </div>`;
}

// shared wrapper: duo top bar → serif wordmark → body → reason → dark footer
function layout({ tagline, pre, body, reason }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>Laclarc</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
${preheader(pre)}
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:${C.card};border-radius:16px;border:1px solid ${C.line};overflow:hidden;">
          <tr>
            <td style="height:5px;line-height:5px;font-size:0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="50%" style="height:5px;line-height:5px;font-size:0;background:${C.lavender};">&nbsp;</td>
                  <td width="50%" style="height:5px;line-height:5px;font-size:0;background:${C.rose};">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:30px 32px 6px;">
              <div style="font-family:${F_SERIF};font-size:26px;font-weight:bold;letter-spacing:5px;color:${C.lavender};">LACLARC</div>
              <div style="font-family:${F_BODY};font-size:10px;font-weight:bold;letter-spacing:2px;color:${C.muted};text-transform:uppercase;margin-top:7px;">${tagline}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 30px;">
${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 20px;">
              <p style="margin:0;font-family:${F_BODY};font-size:11px;color:${C.muted};line-height:1.5;">${reason}</p>
            </td>
          </tr>
          <tr>
            <td style="background:${C.ink};padding:22px 32px;" align="center">
              <p style="margin:0;font-family:${F_BODY};font-size:12px;font-weight:bold;color:#FFFFFF;">Laclarc — Worldwide Insured Shipping</p>
              <p style="margin:8px 0 0;font-family:${F_BODY};font-size:11px;line-height:1.8;">
                <a href="${SITE}" style="color:${C.footerTx};text-decoration:none;">laclarc.com</a>
                &nbsp;·&nbsp;
                <a href="${SITE}/track-order" style="color:${C.footerTx};text-decoration:none;">Track My Order</a>
              </p>
              <p style="margin:8px 0 0;font-family:${F_BODY};font-size:10px;color:${C.footerDm};">&copy; ${year} Laclarc. All rights reserved.</p>
            </td>
          </tr>
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
                  <img src="${imgUrl ? esc(imgUrl) : img}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid ${C.line};">
                </td>
                <td style="padding:14px 0 14px 14px;border-bottom:1px solid ${C.line};vertical-align:top;">
                  <div style="font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.ink};line-height:1.4;">${esc(title)}</div>
                  <div style="font-family:${F_BODY};font-size:12px;color:${C.muted};margin-top:3px;">${qtyLabel}</div>
                </td>
                <td style="padding:14px 0;border-bottom:1px solid ${C.line};text-align:right;vertical-align:top;font-family:${F_BODY};font-size:13px;font-weight:bold;color:${C.rose};white-space:nowrap;">${money(price)}</td>
              </tr>`;
}

function h2(txt) {
  return `<h2 style="margin:0;font-family:${F_BODY};font-size:22px;font-weight:bold;color:${C.ink};line-height:1.3;">${txt}</h2>`;
}

function p(txt, opts = {}) {
  return `<p style="margin:${opts.mt == null ? '12px' : opts.mt} 0 0;font-family:${F_BODY};font-size:14px;color:${C.body};line-height:1.65;">${txt}</p>`;
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
              ${p(`${hi} we received your order <strong style="color:${C.ink};">${num}</strong> and it is already being prepared.`)}
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px;background:${C.soft};border-radius:10px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <span style="font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;color:${C.muted};text-transform:uppercase;">Order</span><br>
                    <span style="font-family:${F_BODY};font-size:16px;font-weight:bold;color:${C.ink};">${num}</span>
                  </td>
                  <td align="right" style="padding:14px 16px;">
                    <span style="display:inline-block;background:${C.lavender};color:#FFFFFF;font-family:${F_BODY};font-size:11px;font-weight:bold;letter-spacing:1px;padding:6px 14px;border-radius:20px;">CONFIRMED ✓</span>
                  </td>
                </tr>
              </table>
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:22px;">
                <tr>
                  <th align="left" style="padding-bottom:10px;border-bottom:2px solid ${C.lavender};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Your items</th>
                  <th align="right" style="padding-bottom:10px;border-bottom:2px solid ${C.lavender};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Price</th>
                </tr>${rows}
              </table>
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
                <tr>
                  <td align="right" style="font-family:${F_BODY};font-size:14px;font-weight:bold;color:${C.ink};">Total paid:&nbsp;
                    <span style="font-size:21px;color:${C.rose};">${money(total)}</span>
                  </td>
                </tr>
              </table>
              ${infoBox('What happens next?', '1. Payment confirmed ✓ &nbsp;·&nbsp; 2. We prepare your order and hand it to our fulfillment partner (CJ Dropshipping). &nbsp;·&nbsp; 3. You get your tracking number by email as soon as it ships.', C.lavender)}
              ${button(`${SITE}/track-order`, 'Track My Order')}
              ${p(`<a href="${SITE}" style="color:${C.lavender};font-weight:bold;text-decoration:none;">Continue shopping →</a>`, { mt: '18px' })}`;

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
              ${infoBox('This link expires in 15 minutes', `If you didn't request a password reset, your account is safe — just ignore this email and your password stays unchanged.`, C.rose)}`;

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
                  <th align="left" style="padding-bottom:10px;border-bottom:2px solid ${C.lavender};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Your bag</th>
                  <th align="right" style="padding-bottom:10px;border-bottom:2px solid ${C.lavender};font-family:${F_BODY};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Order ${num}</th>
                </tr>${rows}
              </table>
              ${promoBox('USE THIS EXCLUSIVE 10% RECOVERY DISCOUNT', 'RECOVER10')}
              ${button(`${SITE}/cart`, 'Complete My Order →')}
              ${p('<span style="color:' + C.muted + ';font-size:12px;">Free Worldwide Insured Shipping &bull; 30-Day Money-Back Guarantee</span>', { mt: '18px' })}`;

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
              ${h2('How was your order? ⭐')}
              ${p(`${hi} your order <strong style="color:${C.ink};">${num}</strong> has been delivered! We hope you love it.`)}
              ${imgHtml}
              ${p('Your honest review takes one minute and helps thousands of shoppers — and helps us get better every day.', { mt: '16px' })}
              ${promoBox('WRITE A REVIEW & GET', '5% OFF NEXT ORDER')}
              ${button(reviewUrl, 'Write My Review ⭐')}
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
