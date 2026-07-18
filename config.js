/* ================================================================
   QUIDDITY DIGITAL — config.js
   Single source of truth for all environment-dependent URLs.
   Include this BEFORE notion.js and script.js on every page.

   TO UPDATE THE WORKER DOMAIN (after DNS setup):
     Change WORKER_URL to: https://workers.quidditydigital.com
   ================================================================ */

const CONFIG = Object.freeze({

  /* Cloudflare Worker API base URL
     ── Current: personal workers.dev subdomain
     ── After DNS setup: https://workers.quidditydigital.com
        (See DEPLOYMENT.md → Step 4: Custom Worker Domain)       */
  WORKER_URL: 'https://quiddity-blog-api.midnightytacc.workers.dev',

  /* Google Apps Script web app URL for bookings                  */
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwf1WHPCIUz1CdDcpLI9b19tuCU1DARmEna7wr2XKPo_-zsYUUSM231T6h4N9prbn4Pgw/exec',
   
  /* Production domain                                             */
  DOMAIN: 'https://quidditydigital.com',

  /* Social media profile URLs — fill in the blanks               */
  SOCIAL: {
    instagram: 'https://www.instagram.com/quiddity_digital',
    linkedin:  'https://www.linkedin.com/company/quiddity-digital',
    twitter:   'https://x.com/QuiddityDigi',
    youtube:   '', // TODO: add YouTube URL
  },

  /* Feature flags                                                 */
  FEATURES: {
    // Set true + add TURNSTILE_SECRET to Apps Script Properties
    TURNSTILE_ENABLED: false,
    // Set true + add GA4_ID below once analytics is set up
    ANALYTICS_ENABLED: true,
  },

  /* Google Analytics 4 Measurement ID
     Format: 'G-XXXXXXXXXX'
     Get from: analytics.google.com → Admin → Data Streams       */
  GA4_ID: 'G-EETV29XDWN', // TODO: add your GA4 ID

});
