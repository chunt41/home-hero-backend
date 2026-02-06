declare module "zipcodes" {
  export type ZipLookupResult = {
    zip: string;
    latitude: number;
    longitude: number;
    city?: string;
    state?: string;
    country?: string;
  };

  export function lookup(zip: string): ZipLookupResult | null;

  /**
   * Returns the distance (in miles) between two ZIP codes, or `null` if either ZIP is unknown.
   */
  export function distance(zipA: string, zipB: string): number | null;
}
