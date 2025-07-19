# 🚀 Deploy Receipt Monitor to Railway

## Files Ready for Deployment ✅

This folder contains everything needed to deploy your receipt monitor to Railway.

## Quick Deploy Steps:

### 1. Create GitHub Repository (Easiest Method)

1. Go to https://github.com and create a new repository called `receipt-monitor`
2. Upload all files from this `cloud_deploy` folder to the repository
3. Go back to Railway and connect your GitHub repository

### 2. Manual Upload to Railway

1. In Railway, click "Deploy from GitHub repo"
2. Select "Deploy from GitHub"
3. Connect your GitHub account
4. Create new repository with these files

### 3. Set Environment Variables

After deployment, add these environment variables in Railway dashboard:

```
GOOGLE_CLIENT_ID=1019839015536-qhuvco15evo3ia11r3tjru81ursupoe2.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=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
GOOGLE_ACCESS_TOKEN=ya29.a0AS3H6NzWRACRe_FynQhdR5BR0goKF2e19_Dc4_ihm7nOsxmz_JKzWQAZyuNfmIGGW2djO8m7ZGKByw3xMVHTikJk-cImEbnxlmNmPWDRveLn-gzlfOoOnUY01BmV3gm0uLccbJljd66JaMSirlBcg2JxIa3r6sUXpg6R06sEaCgYKAYcSARESFQHGX2Mi4DKA0V5cL81svIEyZTbZNQ0175
GOOGLE_REFRESH_TOKEN=1//06-QLrMyl15S8CgYIARAAGAYSNwF-L9IrviMKWK3KtQMrK9J6gFhTD9G58QwEz5SvCh4ua0viR_M39zyWj5iTQf61z1Rc6zWXYjs
TOGETHER_API_KEY=YOUR_TOGETHER_API_KEY_HERE
```

### 4. Deploy!

Railway will automatically deploy your app and give you a URL like:
`https://your-app.railway.app`

## What happens after deployment:

✅ Your receipt monitor runs 24/7 in the cloud
✅ No need to keep your computer on
✅ Automatic token refresh
✅ Access from anywhere
✅ Automatic restarts if it crashes

Your receipt processing system will be live and processing receipts automatically!