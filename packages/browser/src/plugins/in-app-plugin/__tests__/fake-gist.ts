let messageShown = function(message: any) {
    console.log("Fake called with",  message);
}
let messageAction = function(message: any) {
    console.log("Fake called with",  message);
}
let messageDismissed = function(message: any) {
    console.log("Fake called with",  message);
}
let messageError = function(message: any) {
    console.log("Fake called with",  message);
}
export default {
  setup: jest.fn(),
  setUserToken: jest.fn(),
  setCurrentRoute: jest.fn(),
  clearUserToken: jest.fn(),
  events: {
    on: (name: string, cb: any) => {
        if(name == "messageShown") {
            messageShown = cb;
        } else if (name == "messageAction") {
            messageAction = cb;
        } else if (name == "messageDismissed") {
            messageDismissed = cb;
        } else if (name == "messageError") {
            messageError = cb;
        }
    }
  },
  messageShown: function(message: any) {
    messageShown(message);
  },
  messageAction: function(message: any) {
    messageAction(message);
  },
  messageDismissed: function(message: any) {
    messageError(message);
  },
  messageError: function(message: any) {
    messageError(message);
  }
}