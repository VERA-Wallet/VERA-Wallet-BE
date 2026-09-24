/*
 * Copyright 2024 OmniOne.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.omnione.did.sdk.communication.urlconnection;

import org.omnione.did.sdk.communication.exception.CommunicationErrorCode;
import org.omnione.did.sdk.communication.exception.CommunicationException;
import org.omnione.did.sdk.communication.logger.CommunicationLogger;
import org.omnione.did.sdk.wallet.walletservice.logger.WalletLogger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class HttpUrlConnectionTask {
    // Legacy signed credentials retain their original references. Resolve only our
    // exact old service endpoints through their HTTPS alias; never alter signed data.
    public static String resolveEndpoint(String original) throws java.net.MalformedURLException {
        URL url = new URL(original);
        if (!"http".equals(url.getProtocol()) || !"100.109.255.108".equals(url.getHost())
                || url.getUserInfo() != null || url.getRef() != null) return original;
        String prefix;
        switch (url.getPort()) {
            case 8090: prefix = "/tas/"; break;
            case 8091: prefix = "/issuer/"; break;
            case 8092: prefix = "/verifier/"; break;
            case 8093: prefix = "/api-gateway/"; break;
            case 8094: prefix = "/cas/"; break;
            case 8095: prefix = "/wallet/"; break;
            default: return original;
        }
        String path = url.getPath();
        if (!path.startsWith(prefix) && !(url.getPort() == 8090 && path.startsWith("/list/"))) return original;
        return "https://verawallet.pelicanlab.dev/opendid" + url.getFile();
    }

    public HttpUrlConnectionTask(){

    }
    public String makeHttpRequest(String urlString, String method, String payload) throws CommunicationException {
        if(urlString.isEmpty()){
            throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_INVALID_PARAMETER, "urlString");
        }
        if(method.isEmpty()){
            throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_INVALID_PARAMETER, "method");
        }
//        if(payload.isEmpty() && method.equals("POST")){
//            throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_INVALID_PARAMETER, "payload");
//        }
        HttpURLConnection urlConnection = null;
        int responseCode = 0;
        BufferedReader in = null;
        try {
            URL url = new URL(resolveEndpoint(urlString));
            urlConnection = (HttpURLConnection) url.openConnection();
            urlConnection.setRequestMethod(method);
            urlConnection.setInstanceFollowRedirects(false);
            urlConnection.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) VeraWallet-DID/4");
            urlConnection.setReadTimeout(10000);
            urlConnection.setConnectTimeout(15000);
            urlConnection.setRequestProperty("Content-Type", "application/json");
            urlConnection.setRequestProperty("Accept", "application/json");

            if ("POST".equalsIgnoreCase(method)) {
                urlConnection.setDoOutput(true);
                try (OutputStream os = urlConnection.getOutputStream()) {
                    if (payload != null) {
                        byte[] input = payload.getBytes("utf-8");
                        os.write(input, 0, input.length);
                    }
                }
            }
            urlConnection.connect();
            responseCode = urlConnection.getResponseCode();
            if (responseCode == HttpURLConnection.HTTP_OK) {
                in = new BufferedReader(new InputStreamReader(urlConnection.getInputStream()));
                StringBuilder response = new StringBuilder();
                String inputLine;

                while ((inputLine = in.readLine()) != null) {
                    response.append(inputLine);
                }
                in.close();
                return response.toString();
            } else if( responseCode == HttpURLConnection.HTTP_BAD_REQUEST
                    || responseCode == HttpURLConnection.HTTP_SERVER_ERROR) {
                in = new BufferedReader(new InputStreamReader(urlConnection.getErrorStream()));
                StringBuilder error = new StringBuilder();
                String inputLine;
                while ((inputLine = in.readLine()) != null) {
                    error.append(inputLine);
                }
                in.close();
                throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_SERVER_FAIL , error.toString());
            } else {
                in = new BufferedReader(new InputStreamReader(urlConnection.getInputStream()));
                StringBuilder error = new StringBuilder();
                String inputLine;
                while ((inputLine = in.readLine()) != null) {
                    error.append(inputLine);
                }
                in.close();
                throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_INCORRECT_URL_CONNECTION , urlString);
            }
        } catch (IOException e) {
            throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_INCORRECT_URL_CONNECTION , e.getMessage());
        } finally {
            if (urlConnection != null) {
                urlConnection.disconnect();
            }
            if (in != null ) {
                try {
                    in.close();
                } catch (IOException e) {
                    throw new CommunicationException(CommunicationErrorCode.ERR_CODE_COMMUNICATION_UNKNOWN);
                }
            }
        }
    }
}

