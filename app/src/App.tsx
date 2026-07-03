import { IonApp, IonRouterOutlet, setupIonicReact } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { Redirect, Route } from "react-router-dom";
import { ChatPage } from "./ui/pages/ChatPage";
import { NativeSearchPage } from "./ui/pages/NativeSearchPage";
import { ProcureFlow } from "./ui/pages/ProcureFlow";

setupIonicReact();

/**
 * Root app shell. The default route is the end-to-end {@link ProcureFlow} controller that drives the
 * whole MVP loop (Chat → quotes → optimize → approve → checkout → summary) behind the orchestrator.
 * `/chat` exposes the standalone conversation surface for development.
 */
export function App() {
  return (
    <IonApp>
      <IonReactRouter>
        <IonRouterOutlet>
          <Route exact path="/flow" component={ProcureFlow} />
          <Route exact path="/chat" component={ChatPage} />
          <Route exact path="/native" component={NativeSearchPage} />
          <Route exact path="/">
            <Redirect to="/flow" />
          </Route>
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  );
}
