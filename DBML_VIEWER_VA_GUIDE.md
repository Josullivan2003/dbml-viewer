# DBML Viewer Guide for Lead Evaluation

## What to Do

1. Paste a Bubble app URL into the DBML Viewer
2. Click "Fetch Schema" and wait 5-10 seconds
3. Look at the field names in the diagram/code view
4. Check for sensitive data (see checklist below)
5. Flag any apps with sensitive data in your project management tool

---

## Sensitive Data Checklist

Flag the app if you see fields containing:

**Financial**
- credit_card, card_number, bank_account, routing_number, cvv

**Personal ID**
- ssn, social_security, driver_license, passport, date_of_birth

**Health**
- medical_condition, diagnosis, prescription, patient_history, insurance_id

**Authentication**
- password, api_key, secret_token, auth_token

**Location**
- home_address, gps_coordinates, location_history

**Other**
- legal_documents, background_check, government_id

---

## Risk Levels

**HIGH** - Store this data only with extreme caution
- Credit card/banking details
- Social Security Numbers
- Medical/health records
- Passwords or authentication keys
- Personal address + other identifiers combined

**MEDIUM** - Potentially sensitive, depends on context
- Phone numbers or email addresses (if not combined with other data)
- Date of birth
- Location data
- Background check information

**LOW** - Less critical but still monitor
- Insurance ID numbers (without health info)
- Legal document references
- Job titles or salary ranges (if not highly personal)

---

## How to Flag

Add a task to Asana with:
- **Title:** [App URL]
- **Description:** List each table containing sensitive data as bullet points, with sensitive fields as sub-bullets

**Example:**
```
Users
  - ssn
  - date_of_birth
Payments
  - credit_card_number
  - bank_account
```

- **Risk Level:** HIGH/MEDIUM/LOW (use guidance above)

---

## Quick Tips

- **When in doubt, flag it**
- Only flag if fields look suspicious (normal names like "email" or "phone" alone are fine)
- You don't need to understand the technical details
- Ask yourself: "Does this app actually NEED this data?"
