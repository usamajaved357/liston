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

// What the frontend shows: enough to tag a connection and label prices.
function summary(marketplaceId) {
  const m = byId(marketplaceId) || byId(DEFAULT_ID);
  return { id: m.id, label: m.label, name: m.name, flag: m.flag, currency: m.currency, country: m.country, countryName: m.countryName, itemHost: m.itemHost };
}

module.exports = { MARKETPLACES, DEFAULT_ID, byId, fromSite, fromCountry, siteIdFor, currencyFor, summary };
