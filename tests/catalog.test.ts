import { describe, expect, it } from 'vitest';
import { ScalarType, create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  CatalogService,
  ContactBandSchema,
  ImageMaskSchema,
  ProductImageSchema,
  GetProductImagesRequestSchema,
  GetProductImagesResponseSchema,
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  ProductCardSchema,
  SearchProductsRequestSchema,
  SearchProductsResponseSchema,
} from '../src/index.js';

const SURVIVOR = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const MERGED = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const AS_OF = '2026-09-14T11:30:00.123456Z';

const card = {
  headId: SURVIVOR,
  requestedAs: [{ ref: { case: 'headId' as const, value: MERGED } }],
  title: { value: 'Hatsune Miku 1/7 Symphony 2025', asOf: AS_OF },
  manufacturer: { value: 'Good Smile Company', asOf: AS_OF },
  series: { value: 'Character Vocal Series', asOf: AS_OF },
  character: { value: 'Hatsune Miku', asOf: AS_OF },
  scale: { value: '1/7', asOf: AS_OF },
  releaseYm: { value: '2026-08', asOf: AS_OF },
  gtin14s: ['04580590212345'],
  contentLevel: { value: 'general', asOf: AS_OF },
  derivativeIds: ['a'.repeat(64)],
};

describe('CatalogService', () => {
  it('exposes GetProducts, GetProductImages and SearchProducts', () => {
    expect(CatalogService.typeName).toBe('coordinator.v1.CatalogService');
    expect(Object.keys(CatalogService.method).sort()).toEqual(['getProductImages', 'getProducts', 'searchProducts']);
    expect(CatalogService.method.getProducts.input).toBe(GetProductsRequestSchema);
    expect(CatalogService.method.getProducts.output).toBe(GetProductsResponseSchema);
  });
});

describe('GetProducts', () => {
  it('round-trips a mixed batch of refs with paging fields', () => {
    const msg = create(GetProductsRequestSchema, {
      refs: [
        { ref: { case: 'headId', value: SURVIVOR } },
        { ref: { case: 'gtin14', value: '04580590212345' } },
        { ref: { case: 'sourceItem', value: { site: 'mfc', nativeId: '1144' } } },
      ],
      pageSize: 50,
      pageToken: 'opaque',
    });
    const decoded = fromBinary(GetProductsRequestSchema, toBinary(GetProductsRequestSchema, msg));

    expect(equals(GetProductsRequestSchema, msg, decoded)).toBe(true);
    expect(decoded.refs.map((r) => r.ref.case)).toEqual(['headId', 'gtin14', 'sourceItem']);
  });

  it('round-trips a card that answers a redirected ref with the survivor', () => {
    const msg = create(ProductCardSchema, card);
    const decoded = fromJson(ProductCardSchema, toJson(ProductCardSchema, msg));

    expect(equals(ProductCardSchema, msg, decoded)).toBe(true);
    // The holding is keyed on the merged id; the card names the survivor and
    // echoes the ref it answers, which is how the client maps one to the other.
    expect(decoded.headId).toBe(SURVIVOR);
    expect(decoded.requestedAs[0]?.ref).toEqual({ case: 'headId', value: MERGED });
    expect(decoded.title?.asOf).toBe(AS_OF);
  });

  it('keeps an unknown field absent rather than empty', () => {
    const decoded = fromBinary(ProductCardSchema, toBinary(ProductCardSchema, create(ProductCardSchema, { headId: SURVIVOR })));

    expect(decoded.character).toBeUndefined();
    expect(decoded.contentLevel).toBeUndefined();
  });

  it('carries the physical dimensions in whole millimetres, unset when unknown', () => {
    const sized = create(ProductCardSchema, { ...card, heightMm: 470, widthMm: 250, depthMm: 210 });
    const decoded = fromBinary(ProductCardSchema, toBinary(ProductCardSchema, sized));
    expect([decoded.heightMm, decoded.widthMm, decoded.depthMm]).toEqual([470, 250, 210]);
    expect(equals(ProductCardSchema, sized, fromJson(ProductCardSchema, toJson(ProductCardSchema, sized)))).toBe(true);

    const unknown = fromBinary(ProductCardSchema, toBinary(ProductCardSchema, create(ProductCardSchema, card)));
    expect([unknown.heightMm, unknown.widthMm, unknown.depthMm]).toEqual([undefined, undefined, undefined]);
    const dims = ProductCardSchema.fields.filter((f) => /_mm$/.test(f.name));
    expect(dims.map((f) => [f.name, f.number, f.scalar, f.proto.proto3Optional])).toEqual([
      ['height_mm', 12, ScalarType.UINT32, true],
      ['width_mm', 13, ScalarType.UINT32, true],
      ['depth_mm', 14, ScalarType.UINT32, true],
    ]);
  });

  it('carries no inventory field on the card', () => {
    const names = ProductCardSchema.fields.map((f) => f.name);
    expect(names.some((n) => /inventory|stock|quantity/i.test(n))).toBe(false);
  });

  it('round-trips a page with the first-page unresolved list and a continuation', () => {
    const msg = create(GetProductsResponseSchema, {
      products: [card],
      unresolved: [{ ref: { case: 'gtin14', value: '00000000000000' } }],
      nextPageToken: 'next',
    });
    const decoded = fromBinary(GetProductsResponseSchema, toBinary(GetProductsResponseSchema, msg));

    expect(equals(GetProductsResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.nextPageToken).toBe('next');
    expect(decoded.unresolved).toHaveLength(1);
  });
});

describe('GetProductImages', () => {
  it('round-trips derivative refs only', () => {
    const req = create(GetProductImagesRequestSchema, { headIds: [SURVIVOR], pageSize: 0, pageToken: '' });
    expect(equals(GetProductImagesRequestSchema, req, fromBinary(GetProductImagesRequestSchema, toBinary(GetProductImagesRequestSchema, req)))).toBe(true);

    const res = create(GetProductImagesResponseSchema, {
      products: [{
        headId: SURVIVOR,
        images: [{ derivativeId: 'b'.repeat(64), role: 'primary', primary: true, contentType: 'image/webp', width: 800, height: 1200, url: '' }],
      }],
      nextPageToken: '',
    });
    const decoded = fromBinary(GetProductImagesResponseSchema, toBinary(GetProductImagesResponseSchema, res));

    expect(equals(GetProductImagesResponseSchema, res, decoded)).toBe(true);
    const imageFields = GetProductImagesResponseSchema.fields[0]!.message!.fields[1]!.message!.fields.map((f) => f.name);
    expect(imageFields.some((n) => /original|capture|object_key/i.test(n))).toBe(false);
  });

  it('round-trips the mask reference and the grounding fields, all optional', () => {
    const full = create(ProductImageSchema, {
      derivativeId: 'b'.repeat(64),
      role: 'primary',
      primary: true,
      contentType: 'image/webp',
      width: 600,
      height: 800,
      url: 'https://images.figurecollecting.com/d/bb',
      mask: { maskId: 'c'.repeat(64), contentType: 'image/png', url: 'https://images.figurecollecting.com/m/cc' },
      bottomMarginFrac: 0.08,
      contactBand: { centerXFrac: 0.42, widthFrac: 0.31 },
      thumbhash: new Uint8Array([0x1b, 0x08, 0x06, 0x0d, 0x82, 0x77, 0x87, 0x78]),
      dominantColor: '#112233',
    });
    for (const decoded of [
      fromBinary(ProductImageSchema, toBinary(ProductImageSchema, full)),
      fromJson(ProductImageSchema, toJson(ProductImageSchema, full)),
    ]) {
      expect(equals(ProductImageSchema, full, decoded)).toBe(true);
      expect(decoded.bottomMarginFrac).toBe(0.08);
      expect(decoded.contactBand).toMatchObject({ centerXFrac: 0.42, widthFrac: 0.31 });
      expect(decoded.mask?.maskId).toBe('c'.repeat(64));
    }

    const bare = fromBinary(ProductImageSchema, toBinary(ProductImageSchema, create(ProductImageSchema, { derivativeId: 'b'.repeat(64) })));
    expect(bare.mask).toBeUndefined();
    expect(bare.bottomMarginFrac).toBeUndefined();
    expect(bare.contactBand).toBeUndefined();
    expect(bare.thumbhash).toHaveLength(0);
    expect(bare.dominantColor).toBe('');

    // A zero margin is a measurement (the figure touches the bottom edge), so it survives the wire.
    const grounded = fromBinary(ProductImageSchema, toBinary(ProductImageSchema, create(ProductImageSchema, { bottomMarginFrac: 0 })));
    expect(grounded.bottomMarginFrac).toBe(0);
  });

  it('adds the image fields on new numbers only', () => {
    const numbers = Object.fromEntries(ProductImageSchema.fields.map((f) => [f.name, f.number]));
    expect(numbers).toEqual({
      derivative_id: 1, role: 2, primary: 3, content_type: 4, width: 5, height: 6, url: 7,
      mask: 8, bottom_margin_frac: 9, contact_band: 10, thumbhash: 11, dominant_color: 12,
    });
    expect(ImageMaskSchema.fields.map((f) => f.name)).toEqual(['mask_id', 'content_type', 'url']);
    expect(ContactBandSchema.fields.map((f) => [f.name, f.scalar])).toEqual([
      ['center_x_frac', ScalarType.DOUBLE],
      ['width_frac', ScalarType.DOUBLE],
    ]);
  });
});

describe('SearchProducts', () => {
  it('round-trips a query page', () => {
    const req = create(SearchProductsRequestSchema, { query: 'nendoroid miku', pageSize: 50, pageToken: '' });
    expect(equals(SearchProductsRequestSchema, req, fromJson(SearchProductsRequestSchema, toJson(SearchProductsRequestSchema, req)))).toBe(true);

    const res = create(SearchProductsResponseSchema, { products: [card], nextPageToken: 'k' });
    expect(equals(SearchProductsResponseSchema, res, fromBinary(SearchProductsResponseSchema, toBinary(SearchProductsResponseSchema, res)))).toBe(true);
  });
});
