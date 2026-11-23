import { BUILD_REVISION } from "../generated/build-info.ts";

const app = document.querySelector("#app");
if (app) app.textContent = `blip monitor ${BUILD_REVISION}`;
