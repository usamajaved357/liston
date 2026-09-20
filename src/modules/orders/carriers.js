// Carriers a supplier order arrives by, as eBay's shippingCarrierCode
// values, and how to guess one from a tracking number's shape. The guess is
// a default the person can override; "Other" is always allowed.
const CARRIERS = [
  { code: 'Royal Mail', label: 'Royal Mail', pattern: /^[A-Z]{2}\d{9}GB$/i },
  // Evri: 16 characters, letter first (H06R4A0218426976). Yodel: JD/JJD
  // plus digits — the JJD numbers AliExpress hands out for UK last mile.
  { code: 'Evri', label: 'Evri (Hermes)', pattern: /^[A-Z][0-9A-Z]{5}\d{10}$/i },
  { code: 'Yodel', label: 'Yodel', pattern: /^JD\d{16}$|^JJD\d{15,20}$/i },
  { code: 'DHL', label: 'DHL', pattern: /^\d{10}$|^JVGL\d{16,20}$/ },
  { code: 'DPD', label: 'DPD', pattern: /^\d{14}$/ },
  { code: 'UPS', label: 'UPS', pattern: /^1Z[0-9A-Z]{16}$/i },
  { code: 'FedEx', label: 'FedEx', pattern: /^\d{12}$|^\d{15}$/ },
  { code: 'Amazon Logistics', label: 'Amazon Logistics', pattern: /^TB[A-Z]\d{12}$/i },
  { code: 'Yanwen', label: 'Yanwen', pattern: /^(UJ|UF|UG|UK)\d{9}YP$|^Y[A-Z]\d{9}[A-Z]{2}$/i },
  { code: '4PX', label: '4PX', pattern: /^4PX\d{10,12}[A-Z]{0,2}$|^[A-Z]{2}\d{9}(CN|HK)$/i },
  { code: 'Cainiao', label: 'Cainiao', pattern: /^(LP|CN|LZ|LY|LK)\d{12,16}$/i },
  { code: 'China Post', label: 'China Post', pattern: /^[A-Z]{2}\d{9}CN$/i },
  { code: 'SF Express', label: 'SF Express', pattern: /^SF\d{12,15}$/i },
  { code: 'Other', label: 'Other', pattern: null },
];

function detectCarrier(trackingNumber) {
  const t = String(trackingNumber || '').replace(/\s+/g, '').toUpperCase();
  if (!t) return null;
  // Yodel and DHL both use JJD prefixes in the UK; Yodel's are the common
  // ones on AliExpress UK deliveries.
  for (const c of CARRIERS) {
    if (c.pattern && c.pattern.test(t)) return c.code;
  }
  return null;
}

module.exports = { CARRIERS, detectCarrier };
