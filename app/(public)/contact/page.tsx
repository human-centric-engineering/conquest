// app:shim — Sunrise-tracked route file reduced to a re-export of fork-owned
// content (CUSTOMIZATION.md §6) so the contact page can be re-skinned without
// fighting upstream. The page lives in components/app/marketing/contact-page.tsx
// and still renders Sunrise's <ContactForm> (validation / rate-limit / DB write /
// admin email unchanged). Keep this one line on upstream merges ("keep mine").
export { default, metadata } from '@/components/app/marketing/contact-page';
