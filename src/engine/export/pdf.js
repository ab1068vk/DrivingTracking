// SECURITY-HOLD: html2canvas is pinned in package.json/overrides while SUPP-6
// evaluates upgrade or replacement. This PDF export path uses jspdf, which can
// load html2canvas transitively for HTML rendering.
export {
  exportMonthlyReportPDF,
  exportUBIReportPDF,
} from '../../lib/pdfExport.js';
