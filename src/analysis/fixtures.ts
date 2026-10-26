import type { DemoRepository, SourceFile } from './types'

const py = (path: string, source: string): SourceFile => ({ path, language: 'python', source })
const ts = (path: string, source: string): SourceFile => ({ path, language: 'typescript', source })

const pricingBase = py('src/pricing.py', String.raw`def apply_discount(total, percent):
    return total * (1 - percent / 100)


def calculate_total(items, discount=0):
    total = sum(item["price"] * item["quantity"] for item in items)
    return apply_discount(total, discount)
`)

const pricingHead = py('src/pricing.py', String.raw`def apply_discount(total, percent):
    bounded_percent = min(max(percent, 0), 100)
    return total * (1 - bounded_percent / 100)


def calculate_total(items, discount=0):
    total = sum(item["price"] * item["quantity"] for item in items)
    return apply_discount(total, discount)
`)

const checkout = py('src/checkout.py', String.raw`from src.pricing import calculate_total


def checkout(cart, coupon=0):
    return calculate_total(cart, coupon)
`)

const invoice = py('src/invoice.py', String.raw`from src.pricing import calculate_total


def create_invoice(cart):
    total = calculate_total(cart)
    return {"total": total}
`)

const notifications = py('src/notifications.py', String.raw`def notify(client, channel, message):
    return getattr(client, channel)(message)
`)

const pricingTests = py('tests/test_pricing.py', String.raw`from src.pricing import apply_discount, calculate_total


def test_discount_is_applied():
    assert apply_discount(100, 10) == 90


def test_total_uses_discount():
    items = [{"price": 25, "quantity": 2}]
    assert calculate_total(items, 10) == 45
`)

const checkoutTests = py('tests/test_checkout.py', String.raw`from src.checkout import checkout


def test_checkout_returns_total():
    items = [{"price": 10, "quantity": 2}]
    assert checkout(items) == 20
`)

const formatBase = ts('web/format.ts', String.raw`export function formatMoney(amount: number): string {
  return amount.toFixed(2);
}
`)

const formatHead = ts('web/format.ts', String.raw`export function formatMoney(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
`)

const cart = ts('web/cart.ts', String.raw`import { formatMoney } from "./format";

export function renderTotal(amount: number): string {
  return "Total: " + formatMoney(amount);
}
`)

const receipt = ts('web/receipt.ts', String.raw`import { renderTotal } from "./cart";

export function buildReceipt(amount: number): string {
  return renderTotal(amount) + " — paid";
}
`)

const cartTests = ts('tests/cart.test.ts', String.raw`import { renderTotal } from "../web/cart";

it("renders the cart total", () => {
  expect(renderTotal(12.5)).toBe("Total: 12.50");
});
`)

const receiptTests = ts('tests/receipt.test.ts', String.raw`import { buildReceipt } from "../web/receipt";

it("builds a paid receipt", () => {
  expect(buildReceipt(12.5)).toContain("paid");
});
`)

const unchanged = [checkout, invoice, notifications, pricingTests, checkoutTests, cart, receipt, cartTests, receiptTests]

export const demoRepository: DemoRepository = {
  owner: 'northstar-labs',
  name: 'storefront',
  pullRequest: {
    number: 148,
    title: 'Harden discounts and localize currency',
    author: 'maya',
    baseRef: 'main',
    headRef: 'fix/pricing-display',
  },
  base: {
    sha: '8f2c91a',
    files: [pricingBase, formatBase, ...unchanged],
  },
  head: {
    sha: 'c47d3e9',
    files: [pricingHead, formatHead, ...unchanged],
  },
}
