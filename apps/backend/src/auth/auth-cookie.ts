import type { Response } from "express";

const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 1000 };

export function setAuthCookie(response: Response, accessToken: string) { response.cookie("vw_access_token", accessToken, options); }
export function clearAuthCookie(response: Response) { response.clearCookie("vw_access_token", { path: "/" }); }
