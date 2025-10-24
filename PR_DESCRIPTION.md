# Integration Mapping Updates & Code Refactoring

## Summary
This PR updates the integration mapping logic to preserve original item names and implements robust fuzzy matching with token-based scoring. It also includes several bug fixes and code quality improvements.

---

## 🔄 Key Changes

### 1. **Integration Item Mapping Preservation**
Updated `INTEGRATION_PAIRS` to preserve original item names instead of mapping to generic values:

#### Examples of Changes:
- `['Ad Spend ($500)', 'Ad Spend']` → `['Ad Spend ($500)', 'Ad Spend ($500)']`
- `['Ad Spend ($1,000)', 'Ad Spend']` → `['Ad Spend ($1,000)', 'Ad Spend ($1,000)']`
- `['Presence Platform User Seat', 'Additional User Seat']` → `['Presence Platform User Seat', 'Presence Platform User Seat']`
- `['Standard User Seat', 'Agent Subdomains']` → `['Standard User Seat', 'Standard User Seat']`
- All "One-Time Setup Fee" variants now preserve their specific descriptions

**Impact:** Integration items now maintain their original descriptive names, improving clarity and reducing confusion.

---

### 2. **Fuzzy Matching Implementation**
Added sophisticated fuzzy matching algorithm with token-based scoring:

```javascript
// New fuzzy matching helpers
const INTEGRATION_STOPWORDS = new Set([
  'subscription','plan','program','package','activation','setup','set','up',
  'one','time','fee','fees','user','seat','additional','addon','add','on',
  'add on','add-on','tool','service','services'
]);

const INTEGRATION_FLAVOR = new Set([
  'pro','premier','premium','plus','base','enterprise','custom','standard','basic','advanced'
]);
```

**Features:**
- Token-based comparison with stopword filtering
- Jaccard similarity + coverage scoring
- Prevents false matches on flavor-only overlaps (e.g., "Pro" vs "Premier")
- Threshold-based matching (≥0.55 score required)
- Falls back to null if no strong match found

**Benefits:**
- Handles minor variations in item names
- More robust against typos and formatting differences
- Conservative matching to avoid false positives

---

### 3. **Code Refactoring: Extracted PDF Processing**
Created reusable `extractPdfSchedules()` function to consolidate extraction logic:

```javascript
export async function extractPdfSchedules(filePath, fileName, options = {})
```

**Parameters:**
- `filePath`: Path to the PDF file
- `fileName`: Name for OpenAI file upload
- `options`: Processing configuration
  - `model`: AI model selection ('o3', 'o4-mini', 'gpt-4o-mini', 'o3-mini')
  - `forceMulti`: Multi-schedule detection ('auto', 'on', 'off')
  - `runs`: Number of agreement runs (1-5)
  - `format`: Output format ('garage' or 'full')

**Benefits:**
- DRY principle: Eliminates code duplication
- Easier to test and maintain
- Shared between `/api/extract` and `/api/use-contract-assistant`

---

### 4. **Bug Fixes**

#### Fixed Default `number_of_periods` for One-Time Items
**Before:**
```javascript
return { frequency_unit: 'NONE', period: 1, number_of_periods: 0 };
```

**After:**
```javascript
return { frequency_unit: 'NONE', period: 1, number_of_periods: 1 };
```

**Impact:** One-time fees now correctly show 1 period instead of 0, fixing Garage validation issues.

#### Added `start_date` to Retry Logic
The automatic retry now checks for missing `start_date` in addition to `item_name` and zero prices:

```javascript
const hasMissingStart = Array.isArray(norm1) && norm1.some(s => !s?.start_date || !String(s.start_date).trim());
const shouldRerun = hasMissingName || hasMissingStart || allTotalsZero;
```

**Impact:** More complete first-pass extractions with fewer missing fields.

#### Refactored Month Calculation Logic
Split `deriveMonthsOfService()` to separate concerns:
- New: `monthsFromFrequencyOrDefault()` - Calculate months from frequency/periods
- Existing: `deriveMonthsOfService()` - Prioritize dates → explicit months → frequency

**Impact:** Clearer logic flow and better fallback handling.

---

### 5. **API Endpoint Updates**

#### `/api/extract`
- Default `runs` changed from `'2'` to `'1'` (single extraction by default)
- Now uses extracted `extractPdfSchedules()` function
- Maintains all existing query parameters

#### `/api/use-contract-assistant`
- Now uses extracted `extractPdfSchedules()` function
- Fixed API key configuration (consolidated to `USE_CONTRACT_PROCESSING_KEY`)
- Added console logging for debugging
- Maintains retry logic with proper cleanup

---

### 6. **Migration Handling**
Fixed migration item mappings that were incorrectly set to "N/A":

```diff
- ['Press Migration', 'N/A (did not exist previously)'],
+ ['Press Migration', 'Press Migration'],
- ['Neighborhood Migration', 'N/A (did not exist previously)'],
+ ['Neighborhood Migration', 'Neighborhood Migration'],
- ['Development Migration', 'N/A (did not exist previously)'],
+ ['Development Migration', 'Development Migration'],
- ['Testimonial Migration', 'N/A (did not exist previously)'],
+ ['Testimonial Migration', 'Testimonial Migration'],
```

---

## 📊 Technical Details

### Fuzzy Matching Score Calculation
```javascript
const jacc = inter.length / unionSize;           // Jaccard similarity
const covQ = inter.length / setQ.size;           // Query coverage
const covK = inter.length / setK.size;           // Candidate coverage
const score = jacc + 0.25 * covQ + 0.15 * covK + (hasNonFlavorOverlap ? 0.10 : 0);
```

### Token Canonicalization
```javascript
function canonTokens(canonStr) {
  return String(canonStr || '')
    .split(' ')
    .map(t => t.trim())
    .filter(t => t && t.length > 1 && !INTEGRATION_STOPWORDS.has(t));
}
```

---

## 🧪 Testing Recommendations

1. **Integration Mapping Tests:**
   - Verify all setup fees maintain their specific descriptions
   - Test ad spend variants map correctly
   - Confirm user seat types preserve original names

2. **Fuzzy Matching Tests:**
   - Test minor typos in item names
   - Verify no false matches on flavor-only overlaps
   - Confirm threshold prevents weak matches

3. **Frequency Tests:**
   - Verify one-time items show `number_of_periods: 1`
   - Test various frequency/period combinations

4. **API Tests:**
   - Test `/api/extract` with single and multiple runs
   - Test `/api/use-contract-assistant` with both dev and prod environments
   - Verify proper cleanup of temp files

---

## 🚀 Deployment Notes

- **Breaking Changes:** None (backward compatible)
- **Environment Variables:** No new variables required
- **Dependencies:** No new dependencies added

---

## 📝 Related Issues

- Fixes integration item name inconsistencies
- Improves extraction accuracy for one-time fees
- Resolves Garage validation errors for `number_of_periods`
- Enhances code maintainability with function extraction

---

## 👥 Review Checklist

- [ ] Integration mappings preserve original names
- [ ] Fuzzy matching threshold is appropriate (0.55)
- [ ] One-time items correctly set `number_of_periods: 1`
- [ ] API endpoints maintain backward compatibility
- [ ] Code duplication eliminated via `extractPdfSchedules()`
- [ ] Temp file cleanup working properly



