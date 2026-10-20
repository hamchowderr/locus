import { describe, expect, it } from "vitest";
import { checkoutItems } from "./index.ts";

const page = (content: string, path = "app/shop/page.tsx") => ({ path, content });

describe("the products a site's code sells", () => {
  it("reads each <BuyButton>'s product and price written as literals", () => {
    const files = [
      page(
        [
          '<BuyButton productId="prod1" priceId="price1" label="Buy the deep clean" />',
          "<BuyButton priceId='price2' productId='prod2' />",
          '<BuyButton productId={"prod3"} priceId={ `price3` } form="three" />',
          '<BuyButton\n  productId=`prod4`\n  priceId="price4"\n/>',
          // The same pair twice is one item.
          '<BuyButton productId="prod1" priceId="price1" />',
        ].join("\n"),
      ),
      page('<BuyButton productId="prod5" priceId="price5" />', "components/offer.jsx"),
    ];
    expect(checkoutItems(files)).toEqual([
      { productId: "prod1", priceId: "price1" },
      { productId: "prod2", priceId: "price2" },
      { productId: "prod3", priceId: "price3" },
      { productId: "prod4", priceId: "price4" },
      { productId: "prod5", priceId: "price5" },
    ]);
  });

  it("ignores ids worked out at run time, half-written buttons and other files", () => {
    const files = [
      page(
        [
          "<BuyButton productId={item.productId} priceId={item.priceId} />",
          '<BuyButton productId="prod1" priceId={price} />',
          '<BuyButton productId={"prod2" + suffix} priceId="price2" />',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JSX source as text
          '<BuyButton productId={`prod${n}`} priceId="price3" />',
          '<BuyButton productId="prod4" />',
          '<BuyButtons productId="prod5" priceId="price5" />',
          '<Other productId="prod6" priceId="price6" />',
          '<BuyButton productId="../prod7" priceId="price7" />',
          '<BuyButton data-productId="prod8" priceId="price8" />',
        ].join("\n"),
      ),
      page('<BuyButton productId="prod9" priceId="price9" />', "README.md"),
      { path: "app/x.tsx", content: new Uint8Array([1, 2, 3]) },
    ];
    expect(checkoutItems(files)).toEqual([]);
  });
});
