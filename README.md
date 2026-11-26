# feedback.chubbyscafe.com

Guest feedback survey for Chubby's, starting with a pilot at Chubby's Express in Lehi.

## What it does

1. A guest scans a QR code and taps 1 to 5 stars. Survey link for Lehi: `https://feedback.chubbyscafe.com/?s=lehi`
2. **4 or 5 stars:** a large "Review us on Google" button and a free-cookie coupon code.
3. **1 to 3 stars:** a "Let us make this right" form. Sending it posts an alert to a Google Chat space with the comment, name, phone number and a "Mark resolved" link. The guest still gets the coupon and a small Google review link.
4. **Staff redeem coupons** at `https://feedback.chubbyscafe.com/staff` with the staff PIN. Each code works once and lasts 30 days. One coupon per phone per week.
5. **Staff mark a complaint resolved** from the link in the alert, with the staff PIN.
6. A complaint still open after **24 hours** is posted to a second Chat space.

## What is in this folder

- `public/` is the website. Only this folder is published.
  - `index.html` guest survey, `staff.html` coupon redeem page, `resolve.html` mark-resolved page, `styles.css` shared colors and fonts.
- `functions/api/[[path]].js` is the part that saves ratings, makes coupon codes and sends Chat messages. The store list, the offer wording, the 30-day coupon life and the 4-star cutoff are at the top of that file.
- `.github/workflows/followup.yml` runs the hourly check for complaints open more than 24 hours.

## Hosting

Cloudflare Pages connected to this repository, same pattern as the Express and order pages: production branch `main`, no build command, build output directory `public`. Changes merged to `main` go live automatically.

The Cloudflare project needs these (Settings):

| Name | Kind | What it is |
| --- | --- | --- |
| `DB` | D1 database binding | Where ratings, complaints and coupons are stored. Tables are created automatically on first use. |
| `STAFF_PIN` | Secret | PIN staff type to redeem coupons and resolve complaints |
| `CHAT_WEBHOOK_ALERTS` | Secret | Webhook link of the Chat space that gets new low ratings |
| `CHAT_WEBHOOK_FOLLOWUP` | Secret | Webhook link of the Chat space that gets 24-hour follow-ups |
| `CRON_KEY` | Secret | Any long random password. Put the same value in this repository's Actions secrets as `CRON_KEY`. |

## Adding a store

Add it to `STORES` at the top of `functions/api/[[path]].js` with its name, city and Google review link. Its survey link is then `/?s=<key>`. Chat alerts for every store currently go to the same two spaces.

## Where the data is

In the Cloudflare D1 database. To look at it: Cloudflare dashboard > the database > Console, then for example
`SELECT * FROM responses ORDER BY created_at DESC LIMIT 50;` or `SELECT * FROM coupons ORDER BY issued_at DESC LIMIT 50;`
It holds guest names and phone numbers, so keep access to the Cloudflare account limited.
