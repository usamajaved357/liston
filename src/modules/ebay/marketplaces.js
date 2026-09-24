const analyticsDays = require('../analytics/analytics-days');

// The eBay sites Liston knows how to sell on. One row ties together every
// per-market value the rest of the code needs: the Inventory/Account API
// marketplace id, the Trading API site id and its GetUser `Site` name, the
// currency, the country for supplier pricing, and how it's shown in the UI.
const MARKETPLACES = [
  { id: 'EBAY_GB', siteId: 3, site: 'UK', country: 'GB', currency: 'GBP', label: 'UK', name: 'eBay UK', flag: '🇬🇧', locale: 'en-GB', countryName: 'United Kingdom', itemHost: 'www.ebay.co.uk' },
  { id: 'EBAY_US', siteId: 0, site: 'US', country: 'US', currency: 'USD', label: 'US', name: 'eBay US', flag: '🇺🇸', locale: 'en-US', countryName: 'United States', itemHost: 'www.ebay.com' },
  { id: 'EBAY_AU', siteId: 15, site: 'Australia', country: 'AU', currency: 'AUD', label: 'AU', name: 'eBay Australia', flag: '🇦🇺', locale: 'en-AU', countryName: 'Australia', itemHost: 'www.ebay.com.au' },
  { id: 'EBAY_CA', siteId: 2, site: 'Canada', country: 'CA', currency: 'CAD', label: 'CA', name: 'eBay Canada', flag: '🇨🇦', locale: 'en-CA', countryName: 'Canada', itemHost: 'www.ebay.ca' },
  { id: 'EBAY_DE', siteId: 77, site: 'Germany', country: 'DE', currency: 'EUR', label: 'DE', name: 'eBay Germany', flag: '🇩🇪', locale: 'de-DE', countryName: 'Germany', itemHost: 'www.ebay.de' },
  { id: 'EBAY_FR', siteId: 71, site: 'France', country: 'FR', currency: 'EUR', label: 'FR', name: 'eBay France', flag: '🇫🇷', locale: 'fr-FR', countryName: 'France', itemHost: 'www.ebay.fr' },
  { id: 'EBAY_IT', siteId: 101, site: 'Italy', country: 'IT', currency: 'EUR', label: 'IT', name: 'eBay Italy', flag: '🇮🇹', locale: 'it-IT', countryName: 'Italy', itemHost: 'www.ebay.it' },
  { id: 'EBAY_ES', siteId: 186, site: 'Spain', country: 'ES', currency: 'EUR', label: 'ES', name: 'eBay Spain', flag: '🇪🇸', locale: 'es-ES', countryName: 'Spain', itemHost: 'www.ebay.es' },
  { id: 'EBAY_IE', siteId: 205, site: 'Ireland', country: 'IE', currency: 'EUR', label: 'IE', name: 'eBay Ireland', flag: '🇮🇪', locale: 'en-IE', countryName: 'Ireland', itemHost: 'www.ebay.ie' },
];

const DEFAULT_ID = 'EBAY_GB';

function byId(id) {
  return MARKETPLACES.find((m) => m.id === id) || null;
}

// GetUser's `Site` ("UK", "US", "Australia" ...) to a marketplace.
function fromSite(site) {
  return MARKETPLACES.find((m) => m.site === site) || null;
}

function fromCountry(country) {
  return MARKETPLACES.find((m) => m.country === String(country || '').toUpperCase()) || null;
}

function siteIdFor(marketplaceId) {
  return byId(marketplaceId)?.siteId ?? 0;
}

function currencyFor(marketplaceId) {
  return byId(marketplaceId)?.currency || 'GBP';
}

// Each site's own clock: the analytics days' zones, plus the sites eBay's
// traffic report doesn't cover.
const OTHER_TIME_ZONES = { EBAY_CA: 'America/Toronto', EBAY_IE: 'Europe/Dublin', EBAY_NL: 'Europe/Amsterdam' };
function timeZoneOf(marketplaceId) {
  return analyticsDays.timeZoneFor(marketplaceId) || OTHER_TIME_ZONES[marketplaceId] || 'Europe/London';
}

// What the frontend shows: enough to tag a connection and label prices.
function summary(marketplaceId) {
  const m = byId(marketplaceId) || byId(DEFAULT_ID);
  const copy = templateCopy(m.id);
  return {
    id: m.id,
    label: m.label,
    name: m.name,
    flag: m.flag,
    currency: m.currency,
    country: m.country,
    countryName: m.countryName,
    itemHost: m.itemHost,
    // The site's own clock: every date on the account's pages is shown in it.
    timeZone: timeZoneOf(m.id),
    // The market's wording for the description template, so the Settings
    // page can show the right defaults before anything is saved.
    template: { tagline: copy.tagline, warehouse: copy.warehouse, carrier: copy.carrier, region: copy.region, postageWord: copy.postageWord },
  };
}

// The wording a store's description template uses for its own market:
// where it's based, who delivers, what postage is called. A US account must
// never publish "UK Based · Royal Mail".
const TEMPLATE_COPY = {
  EBAY_GB: { region: 'UK', carrier: 'Royal Mail / Evri', postage: 'P&P', business: 'UK Business' },
  EBAY_US: { region: 'US', carrier: 'USPS / UPS', postage: 'Shipping', business: 'US Business' },
  EBAY_AU: { region: 'Australian', carrier: 'Australia Post / Aramex', postage: 'Shipping', business: 'Australian Business' },
  EBAY_CA: { region: 'Canadian', carrier: 'Canada Post / UPS', postage: 'Shipping', business: 'Canadian Business' },
  EBAY_DE: { region: 'German', carrier: 'DHL / Hermes', postage: 'Shipping', business: 'German Business' },
  EBAY_FR: { region: 'French', carrier: 'Colissimo / Chronopost', postage: 'Shipping', business: 'French Business' },
  EBAY_IT: { region: 'Italian', carrier: 'Poste Italiane / BRT', postage: 'Shipping', business: 'Italian Business' },
  EBAY_ES: { region: 'Spanish', carrier: 'Correos / SEUR', postage: 'Shipping', business: 'Spanish Business' },
  EBAY_IE: { region: 'Irish', carrier: 'An Post / DPD', postage: 'Shipping', business: 'Irish Business' },
};

function templateCopy(marketplaceId) {
  const m = byId(marketplaceId) || byId(DEFAULT_ID);
  const copy = TEMPLATE_COPY[m.id] || TEMPLATE_COPY[DEFAULT_ID];
  return {
    marketplaceId: m.id,
    flag: m.flag,
    countryName: m.countryName,
    region: copy.region,
    carrier: copy.carrier,
    postageWord: copy.postage,
    business: copy.business,
    tagline: `Official ${copy.region} Store`,
    warehouse: `From our ${copy.region} warehouse`,
    based: `${copy.region} Based`,
    stock: `${copy.region} Stock`,
    orders: `All ${copy.region} orders`,
    addresses: `All ${copy.region} addresses`,
  };
}

module.exports = { MARKETPLACES, DEFAULT_ID, byId, fromSite, fromCountry, siteIdFor, currencyFor, timeZoneOf, summary, templateCopy };
