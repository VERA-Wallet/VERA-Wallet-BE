export type JwtPayload = {
  sub: string;
  didHash: string;
  countryCode: string | null;
};

export type AuthenticatedUser = JwtPayload;
