# Geocoding Setup Guide

This guide will help you set up the geocoding service to enable the member map feature.

---

## Quick Start

### Step 1: Get an OpenCage API Key (Free)

1. Go to https://opencagedata.com/
2. Click "Sign Up" (top right)
3. Create a free account
4. Verify your email
5. Go to your dashboard: https://opencagedata.com/dashboard
6. Copy your API key

**Free Tier Limits:**
- 2,500 requests per day
- 1 request per second
- More than enough for your needs!

### Step 2: Add API Key to .env File

1. Open the `.env` file in the project root
2. Replace `your_api_key_here` with your actual API key:

```env
OPENCAGE_API_KEY=YOUR_ACTUAL_API_KEY_HERE
```

3. Save the file

### Step 3: Restart the Server

Stop the server (Ctrl+C) and restart it:

```bash
npm start
```

You should see:
```
Geocoding service initialized (OpenCage)
```

If you see "Geocoding disabled", check that your API key is correct in the `.env` file.

---

## Using the Member Map

### First Time Setup

1. Navigate to the **Map** page in your application
2. Click the **"Geocode All Members"** button
3. Wait for the process to complete (about 6-7 minutes for 370 members)
4. The map will automatically refresh and show all member locations

### What Happens During Geocoding

- Each member's address is sent to OpenCage API
- The API returns latitude/longitude coordinates
- Coordinates are saved to the member record
- Process respects rate limits (1.1 seconds between requests)

### After Initial Geocoding

- New members are NOT automatically geocoded
- You can geocode individual members or run batch geocoding again
- Coordinates are cached, so the map loads instantly

---

## Alternative: Use Nominatim (No API Key Required)

If you don't want to sign up for OpenCage, you can use Nominatim (free, no key needed):

### Update server.js

Find this section (around line 210):

```javascript
const geocoderOptions = {
    provider: 'opencage',
    apiKey: process.env.OPENCAGE_API_KEY || '',
    formatter: null
};
```

Replace with:

```javascript
const geocoderOptions = {
    provider: 'openstreetmap',  // Changed from 'opencage'
    formatter: null
};
```

Then update the initialization (around line 217):

```javascript
let geocoder = null;
geocoder = NodeGeocoder(geocoderOptions);  // Remove the API key check
console.log('Geocoding service initialized (Nominatim/OpenStreetMap)');
```

**Note:** Nominatim is slower (1 request per second limit) but completely free and requires no API key.

---

## Troubleshooting

### "Geocoding service not configured" Error

**Problem:** API key not set or invalid

**Solution:**
1. Check that `.env` file exists in project root
2. Verify API key is correct (no extra spaces)
3. Restart the server after changing `.env`

### "Geocoding failed - no results returned"

**Problem:** Address not found by geocoding service

**Possible causes:**
- Invalid or incomplete address
- Typo in street name
- Address doesn't exist

**Solution:**
- Check the member's address for errors
- Edit the member and correct the address
- Try geocoding again

### Geocoding is Very Slow

**Problem:** Rate limiting

**Explanation:**
- OpenCage: 1 request per second (free tier)
- For 370 members: ~6-7 minutes total
- This is normal and expected

**Solution:**
- Be patient during initial geocoding
- Run during off-hours
- Consider upgrading to paid tier for faster processing

### Map Shows No Markers

**Problem:** No members have been geocoded yet

**Solution:**
1. Click "Check Geocoding Status" button
2. If "Needs Geocoding" > 0, click "Geocode All Members"
3. Wait for process to complete

---

## API Key Security

### Important Security Notes

✅ **DO:**
- Keep your API key in the `.env` file
- Add `.env` to `.gitignore` (already done)
- Never commit `.env` to version control
- Regenerate key if accidentally exposed

❌ **DON'T:**
- Put API key directly in code
- Share your API key publicly
- Commit `.env` file to Git
- Use API key in frontend JavaScript

### The `.env` file is already in `.gitignore`

Your API key is safe and won't be committed to version control.

---

## Cost Estimates

### OpenCage Free Tier

- **Limit:** 2,500 requests/day
- **Your usage:** ~370 requests (one-time) + ~1-5/day (new members)
- **Cost:** $0 (free forever for your scale)

### If You Exceed Free Tier

Paid plans start at:
- **$50/month:** 10,000 requests/day
- **$200/month:** 50,000 requests/day

**You won't need this** unless you're geocoding thousands of members daily.

---

## Testing the Setup

### Test 1: Check Server Logs

After restarting with API key, you should see:
```
Geocoding service initialized (OpenCage)
```

### Test 2: Check Geocoding Status

1. Go to Member Map page
2. Click "Check Geocoding Status"
3. Should show statistics

### Test 3: Geocode a Single Member (Manual Test)

Open browser console and run:
```javascript
fetch('/api/members/1768104437933/geocode', { method: 'POST' })
    .then(r => r.json())
    .then(console.log);
```

Should return coordinates for that member.

---

## FAQ

**Q: Do I need to geocode members every time I start the server?**  
A: No! Coordinates are saved to the member records and persist.

**Q: What happens if I add a new member?**  
A: New members won't appear on the map until geocoded. You can either:
- Geocode individual members
- Run batch geocoding again (it skips already-geocoded members)

**Q: Can I use a different geocoding service?**  
A: Yes! The `node-geocoder` library supports many providers:
- Google Maps
- Mapbox
- Here Maps
- LocationIQ
- And more

**Q: Will this work offline?**  
A: The map tiles require internet, but once geocoded, coordinates are stored locally.

**Q: How accurate are the coordinates?**  
A: Very accurate! Geocoding services typically provide accuracy within 10-50 meters.

---

## Next Steps

1. Get your OpenCage API key
2. Add it to `.env` file
3. Restart the server
4. Go to Member Map page
5. Click "Geocode All Members"
6. Enjoy your interactive map!

---

## Support

If you encounter issues:
1. Check server console for error messages
2. Verify API key is correct
3. Check that addresses are complete
4. Review the implementation plan: `plans/member-map-implementation-plan.md`

---

**Happy Mapping! 🗺️**
